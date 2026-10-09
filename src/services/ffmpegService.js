const { execFile } = require('child_process');
const util = require('util');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const Queue = require('bull');
const HetznerService = require('./HetznerService');
const logger = require('../config/logger');
const { Readable } = require('stream');

const execFileAsync = util.promisify(execFile);

// ffmpeg/ffprobe run inside this image (Dockerfile installs ffmpeg). Previously every call
// was `docker exec ffmpeg-worker …`, which required mounting the host Docker socket into
// this container — i.e. a compromised ffmpeg-service could control Docker on the host.
// Arguments are always passed as an array (execFile, no shell).
const FFMPEG = process.env.FFMPEG_PATH || 'ffmpeg';
const FFPROBE = process.env.FFPROBE_PATH || 'ffprobe';
// Each job gets its own private (0700, mkdtemp) directory under this root, removed after.
const WORK_ROOT = process.env.VIDEO_WORK_DIR || os.tmpdir();
const MAX_BUFFER = 16 * 1024 * 1024;

const runFfmpeg = (args, timeout) =>
  execFileAsync(FFMPEG, ['-hide_banner', '-loglevel', 'error', ...args], {
    timeout,
    maxBuffer: MAX_BUFFER,
  });

// ---------------------------------------------------------------------------
// Bull queue — backed by Redis
// ---------------------------------------------------------------------------
const transcodeQueue = new Queue('video transcoding', {
  redis: {
    host: process.env.REDIS_HOST || 'redis',
    port: parseInt(process.env.REDIS_PORT || '6379', 10),
    retryDelayOnFailure: 1000,
    maxRetriesPerRequest: 3,
  },
  defaultJobOptions: {
    removeOnComplete: 10,
    removeOnFail: 5,
  },
});

class FFmpegService {
  constructor() {
    this.setupQueue();
  }

  // ---------------------------------------------------------------------------
  // Queue wiring
  // ---------------------------------------------------------------------------
  setupQueue() {
    transcodeQueue.process('transcode-user', 1, async (job) => {
      return await this.processVideoVariants(job.data);
    });

    transcodeQueue.on('completed', (job, result) => {
      logger.info(`Job ${job.id} completed for ${job.data.fileKey} — variants: ${result.variants}`);
    });

    transcodeQueue.on('failed', (job, err) => {
      logger.error(`Job ${job.id} failed for ${job.data.fileKey}: ${err.message}`);
    });

    transcodeQueue.on('stalled', (job) => {
      logger.warn(`Job ${job.id} stalled for ${job.data.fileKey}`);
    });
  }

  async queueTranscoding(options) {
    const job = await transcodeQueue.add('transcode-user', options, {
      priority: 1,
      attempts: 3,
      backoff: { type: 'exponential', delay: 2000 },
      removeOnComplete: 10,
      removeOnFail: 5,
    });

    logger.info(`Queued transcoding job ${job.id} for ${options.fileKey}`);
    return { jobId: job.id, status: 'queued' };
  }

  // ---------------------------------------------------------------------------
  // Main processing — called inside the Bull worker
  // ---------------------------------------------------------------------------
  async processVideoVariants(options) {
    const { fileKey, mediaContent } = options;
    let workDir = null;

    try {
      logger.info(`Starting transcoding for ${fileKey}`);

      // ── 1. Write incoming base64 content into a private per-job directory ──
      workDir = fs.mkdtempSync(path.join(WORK_ROOT, 'xcl-transcode-'));
      const tempId = crypto.randomUUID();
      const inputPath = path.join(workDir, `input-${tempId}.mp4`);

      const buffer = Buffer.from(mediaContent, 'base64');
      await new Promise((resolve, reject) => {
        const readable = Readable.from(buffer);
        const writeStream = fs.createWriteStream(inputPath);
        readable.pipe(writeStream);
        readable.on('error', reject);
        writeStream.on('finish', resolve);
        writeStream.on('error', reject);
      });

      logger.info(`Wrote ${buffer.length} bytes to ${inputPath}`);

      // ── 2. Probe the input to get real dimensions ─────────────────────────
      const probe = await this.probeVideo(inputPath);
      logger.info(
        `Probe result: ${probe.width}x${probe.height}, audio=${probe.hasAudio}, codec=${probe.codec}`
      );

      if (probe.height === 0) {
        logger.error(`Cannot transcode ${fileKey}: probe returned no video stream`);
        return { success: false, variants: 0 };
      }

      // ── 3. Build target list (only resolutions BELOW the source height) ───
      const paths = {
        p1080: fileKey.replace('original', '1080p'),
        p720: fileKey.replace('original', '720p'),
        p480: fileKey.replace('original', '480p'),
        p360: fileKey.replace('original', '360p'),
      };
      const targets = this.getTargetsBelowSource(probe.height, paths);

      if (targets.length === 0) {
        logger.info(`No variants needed for ${fileKey} — source is already at or below 360p`);
        return { success: true, variants: 0 };
      }

      // ── 4. Transcode each variant (sequentially to avoid OOM) ───────────
      let successCount = 0;
      for (const target of targets) {
        const outputPath = path.join(workDir, `output-${tempId}-${target.h}p.mp4`);

        try {
          const ok = await this.transcodeVariant(target, inputPath, outputPath, probe.hasAudio);
          if (ok) successCount++;
        } finally {
          this.cleanupFile(outputPath);
        }
      }

      logger.info(
        `Transcoding done for ${fileKey}: ${successCount}/${targets.length} variants uploaded`
      );
      return { success: true, variants: successCount };
    } catch (error) {
      logger.error(`Transcoding pipeline failed for ${fileKey}: ${error.message}`);
      throw error;
    } finally {
      if (workDir) this.cleanupDir(workDir);
    }
  }

  // ---------------------------------------------------------------------------
  // Target selection — source is already stored; create only LOWER resolutions
  //
  // Rule: create a variant only if source height STRICTLY exceeds target height.
  // Example:
  //   source 1920×1080 → variants: 720p, 480p, 360p   (no 1080p — already uploaded)
  //   source 1280×720  → variants: 480p, 360p          (no 720p  — already uploaded)
  //   source 3840×2160 → variants: 1080p, 720p, 480p, 360p
  //   source  640×360  → variants: none                (already at lowest standard)
  // ---------------------------------------------------------------------------
  getTargetsBelowSource(sourceHeight, paths) {
    const targets = [];

    if (sourceHeight > 1080) targets.push({ h: 1080, key: 'p1080', path: paths.p1080 });
    if (sourceHeight > 720) targets.push({ h: 720, key: 'p720', path: paths.p720 });
    if (sourceHeight > 480) targets.push({ h: 480, key: 'p480', path: paths.p480 });
    if (sourceHeight > 360) targets.push({ h: 360, key: 'p360', path: paths.p360 });

    logger.info(
      `Source height=${sourceHeight}px → creating variants: [${targets.map((t) => t.h + 'p').join(', ') || 'none'}]`
    );
    return targets;
  }

  // ---------------------------------------------------------------------------
  // Transcoding a single variant — tries strategies in order, uploads on success
  // ---------------------------------------------------------------------------
  async transcodeVariant(target, inputPath, outputPath, hasAudio) {
    logger.info(`Transcoding → ${target.h}p (output: ${path.basename(outputPath)})`);

    // Strategies from best quality to last resort.
    // All use scale=-2:height so aspect ratio is always preserved (portrait or landscape).
    const strategies = [
      // 1. Optimal — H.264 veryfast, proper audio normalisation
      () => this.strategyOptimal(inputPath, outputPath, target.h, hasAudio),
      // 2. Conservative — medium preset, slightly more compatible
      () => this.strategyConservative(inputPath, outputPath, target.h, hasAudio),
      // 3. Simple — ultrafast, stream-copy audio
      () => this.strategySimple(inputPath, outputPath, target.h, hasAudio),
      // 4. Fast re-encode — ultrafast + aac, very low quality but always produces output
      () => this.strategyFastReencode(inputPath, outputPath, target.h),
      // 5. Last resort — mpeg4 container, preserves aspect ratio, maximum compatibility
      () => this.strategyLastResort(inputPath, outputPath, target.h),
    ];

    for (let i = 0; i < strategies.length; i++) {
      try {
        await strategies[i]();

        if (fs.existsSync(outputPath)) {
          const { size } = fs.statSync(outputPath);
          if (size > 1024) {
            const transcodedBuffer = fs.readFileSync(outputPath);
            await HetznerService.uploadBuffer(transcodedBuffer, target.path);
            logger.info(
              `✅ ${target.h}p uploaded via strategy ${i + 1} (${size} bytes) → ${target.path}`
            );
            return true;
          }
          logger.warn(`Strategy ${i + 1} wrote empty/tiny file for ${target.h}p (${size} bytes)`);
        } else {
          logger.warn(`Strategy ${i + 1} produced no output file for ${target.h}p`);
        }
      } catch (e) {
        logger.warn(`Strategy ${i + 1} failed for ${target.h}p: ${e.message}`);
      }
    }

    logger.error(`❌ All strategies failed for ${target.h}p`);
    return false;
  }

  // ---------------------------------------------------------------------------
  // FFmpeg strategy implementations
  //
  // All use "scale=-2:HEIGHT" — the -2 flag means:
  //   - width is auto-calculated to maintain aspect ratio
  //   - width is forced to the nearest even number (required by H.264)
  // This works correctly for both landscape AND portrait videos.
  // ---------------------------------------------------------------------------

  async strategyOptimal(inputPath, outputPath, height, hasAudio) {
    await runFfmpeg(
      [
        '-i',
        inputPath,
        '-vf',
        `scale=-2:${height}`,
        '-c:v',
        'libx264',
        '-preset',
        'veryfast',
        '-crf',
        '23',
        '-pix_fmt',
        'yuv420p',
        '-profile:v',
        'main',
        '-level',
        '4.0',
        '-movflags',
        '+faststart',
        '-g',
        '48',
        '-keyint_min',
        '48',
        ...(hasAudio ? ['-c:a', 'aac', '-b:a', '128k', '-ar', '44100', '-ac', '2'] : ['-an']),
        '-y',
        outputPath,
      ],
      600000
    );
  }

  async strategyConservative(inputPath, outputPath, height, hasAudio) {
    await runFfmpeg(
      [
        '-i',
        inputPath,
        '-vf',
        `scale=-2:${height}`,
        '-c:v',
        'libx264',
        '-preset',
        'medium',
        '-crf',
        '26',
        '-pix_fmt',
        'yuv420p',
        '-movflags',
        '+faststart',
        ...(hasAudio ? ['-c:a', 'aac', '-b:a', '96k'] : ['-an']),
        '-y',
        outputPath,
      ],
      600000
    );
  }

  async strategySimple(inputPath, outputPath, height, hasAudio) {
    await runFfmpeg(
      [
        '-i',
        inputPath,
        '-vf',
        `scale=-2:${height}`,
        '-c:v',
        'libx264',
        '-preset',
        'ultrafast',
        '-crf',
        '30',
        ...(hasAudio ? ['-c:a', 'copy'] : ['-an']),
        '-y',
        outputPath,
      ],
      300000
    );
  }

  async strategyFastReencode(inputPath, outputPath, height) {
    // Does NOT stream-copy — uses ultrafast + force audio encode.
    // Works even when the source audio codec is incompatible.
    await runFfmpeg(
      [
        '-i',
        inputPath,
        '-vf',
        `scale=-2:${height}`,
        '-c:v',
        'libx264',
        '-preset',
        'ultrafast',
        '-crf',
        '35',
        '-c:a',
        'aac',
        '-b:a',
        '64k',
        '-y',
        outputPath,
      ],
      300000
    );
  }

  async strategyLastResort(inputPath, outputPath, height) {
    // mpeg4 container — maximum compatibility.
    // Uses -2 to preserve aspect ratio (portrait AND landscape safe).
    await runFfmpeg(
      [
        '-i',
        inputPath,
        '-vf',
        `scale=-2:${height}`,
        '-c:v',
        'mpeg4',
        '-b:v',
        '1000k',
        '-c:a',
        'mp3',
        '-b:a',
        '128k',
        '-f',
        'mp4',
        '-y',
        outputPath,
      ],
      300000
    );
  }

  // ---------------------------------------------------------------------------
  // ffprobe — get actual video dimensions
  // ---------------------------------------------------------------------------
  async probeVideo(inputPath) {
    try {
      const { stdout } = await execFileAsync(
        FFPROBE,
        ['-v', 'quiet', '-print_format', 'json', '-show_format', '-show_streams', inputPath],
        { timeout: 30000, maxBuffer: MAX_BUFFER }
      );
      const probe = JSON.parse(stdout);

      const videoStream = probe.streams.find((s) => s.codec_type === 'video');
      if (!videoStream) throw new Error('No video stream found in probe output');

      return {
        height: videoStream.height || 0,
        width: videoStream.width || 0,
        duration: parseFloat(probe.format?.duration || 0),
        hasAudio: probe.streams.some((s) => s.codec_type === 'audio'),
        codec: videoStream.codec_name || 'unknown',
        fps: parseFloat(videoStream.r_frame_rate?.split('/')[0] || 30),
      };
    } catch (error) {
      logger.error(`ffprobe failed: ${error.message}`);
      // Return height=0 — getTargetsBelowSource will produce no variants,
      // which is safer than creating variants with wrong assumptions.
      return { height: 0, width: 0, duration: 0, hasAudio: false, codec: 'unknown', fps: 30 };
    }
  }

  // ---------------------------------------------------------------------------
  // Queue status / job status helpers
  // ---------------------------------------------------------------------------
  async getQueueStatus() {
    const [waiting, active, completed, failed] = await Promise.all([
      transcodeQueue.getWaiting(),
      transcodeQueue.getActive(),
      transcodeQueue.getCompleted(),
      transcodeQueue.getFailed(),
    ]);

    return {
      waiting: waiting.length,
      active: active.length,
      completed: completed.length,
      failed: failed.length,
    };
  }

  async getJobStatus(jobId) {
    const job = await transcodeQueue.getJob(jobId);
    if (!job) return { status: 'not_found' };

    return {
      id: job.id,
      status: await job.getState(),
      progress: job.progress(),
      data: { fileKey: job.data.fileKey },
      createdAt: new Date(job.timestamp),
      processedAt: job.processedOn ? new Date(job.processedOn) : null,
      finishedAt: job.finishedOn ? new Date(job.finishedOn) : null,
    };
  }

  // ---------------------------------------------------------------------------
  // Poster frame — SYNCHRONOUS single-frame extraction for a <video poster>.
  //
  // One still per video, scaled to <= `width` px wide at the video's native aspect
  // (portrait-safe), encoded WebP. Returns base64 so the CALLER (post-service, the
  // sole writer of post_media) uploads it to Hetzner and records thumbnail_url —
  // this service stays stateless. Best-effort: returns null on any failure so the
  // upload still succeeds with no poster (frontend falls back to preload=metadata).
  //
  // Runs ffmpeg IN-PROCESS via runFfmpeg (execFile, no docker socket) in a private
  // per-job mkdtemp dir — same model as transcode (ARCH-007 D6).
  // ---------------------------------------------------------------------------
  async generatePoster({ mediaContent, width = 720 }) {
    let workDir = null;
    try {
      workDir = fs.mkdtempSync(path.join(WORK_ROOT, 'xcl-poster-'));
      const inputPath = path.join(workDir, 'input.mp4');
      const outputPath = path.join(workDir, 'poster.webp');

      const buffer = Buffer.from(mediaContent, 'base64');
      await new Promise((resolve, reject) => {
        const readable = Readable.from(buffer);
        const writeStream = fs.createWriteStream(inputPath);
        readable.pipe(writeStream);
        readable.on('error', reject);
        writeStream.on('finish', resolve);
        writeStream.on('error', reject);
      });

      const probe = await this.probeVideo(inputPath);
      // Seek ~10% in (capped at 1s) to skip a black/leader first frame; 0 for very
      // short clips or when duration is unknown.
      const seek = probe.duration > 0 ? Math.min(1, probe.duration * 0.1) : 0;

      // Cap width at the source width without upscaling. The comma inside min() is
      // escaped (\,) because execFile passes the filtergraph verbatim (no shell).
      const extract = (ss) =>
        runFfmpeg(
          [
            '-ss',
            String(ss),
            '-i',
            inputPath,
            '-frames:v',
            '1',
            '-vf',
            `scale=min(${width}\\,iw):-2`,
            '-c:v',
            'libwebp',
            '-q:v',
            '80',
            '-y',
            outputPath,
          ],
          60000
        );

      const produced = () => fs.existsSync(outputPath) && fs.statSync(outputPath).size > 64;

      try {
        await extract(seek);
      } catch (e) {
        logger.warn(`Poster extract at ss=${seek} failed: ${e.message}; retrying at 0`);
      }
      if (!produced()) {
        try {
          await extract(0);
        } catch (e) {
          logger.warn(`Poster extract at ss=0 failed: ${e.message}`);
        }
      }
      if (!produced()) {
        logger.error('Poster generation produced no output');
        return null;
      }

      const posterBuffer = fs.readFileSync(outputPath);
      logger.info(
        `Poster generated (${posterBuffer.length} bytes, ${probe.width}x${probe.height})`
      );
      return {
        poster: posterBuffer.toString('base64'),
        contentType: 'image/webp',
        width: probe.width || null,
        height: probe.height || null,
      };
    } catch (error) {
      logger.error(`Poster generation failed: ${error.message}`);
      return null;
    } finally {
      if (workDir) this.cleanupDir(workDir);
    }
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------
  cleanupFile(filePath) {
    try {
      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
        logger.debug(`Cleaned up ${filePath}`);
      }
    } catch (e) {
      logger.warn(`Failed to clean up ${filePath}: ${e.message}`);
    }
  }

  // Remove a per-job working directory and everything in it.
  cleanupDir(dirPath) {
    try {
      fs.rmSync(dirPath, { recursive: true, force: true });
      logger.debug(`Cleaned up ${dirPath}`);
    } catch (e) {
      logger.warn(`Failed to clean up ${dirPath}: ${e.message}`);
    }
  }
}

module.exports = new FFmpegService();
