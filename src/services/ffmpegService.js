const { exec } = require('child_process');
const util = require('util');
const fs = require('fs');
const path = require('path');
const Queue = require('bull');
const HetznerService = require('./HetznerService');
const logger = require('../config/logger');
const { Readable } = require('stream');

const execAsync = util.promisify(exec);

// Shared directory — bind-mounted on both ffmpeg-service and ffmpeg-worker containers
// Host path: /tmp/xclusively-videos (see docker-compose.yml)
const SHARED_VIDEO_PATH = '/tmp/videos';

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
    const { fileKey, mediaContent, timestamp = Date.now() } = options;
    let inputPath = null;

    try {
      logger.info(`Starting transcoding for ${fileKey}`);

      // ── 1. Write incoming base64 content to a temp file ──────────────────
      const tempId = `${timestamp}-${Math.random().toString(36).substring(7)}`;
      const inputFile = `input-${tempId}.mp4`;
      inputPath = path.join(SHARED_VIDEO_PATH, inputFile);

      if (!fs.existsSync(SHARED_VIDEO_PATH)) {
        fs.mkdirSync(SHARED_VIDEO_PATH, { recursive: true });
      }

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
      const probe = await this.probeVideo(inputFile);
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
        const outputFile = `output-${tempId}-${target.h}p.mp4`;
        const outputPath = path.join(SHARED_VIDEO_PATH, outputFile);

        try {
          const ok = await this.transcodeVariant(
            target,
            inputFile,
            outputFile,
            probe.hasAudio,
            outputPath
          );
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
      if (inputPath) this.cleanupFile(inputPath);
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
  async transcodeVariant(target, inputFile, outputFile, hasAudio, outputPath) {
    logger.info(`Transcoding → ${target.h}p (output: ${outputFile})`);

    // Strategies from best quality to last resort.
    // All use scale=-2:height so aspect ratio is always preserved (portrait or landscape).
    const strategies = [
      // 1. Optimal — H.264 veryfast, proper audio normalisation
      () => this.strategyOptimal(inputFile, outputFile, target.h, hasAudio),
      // 2. Conservative — medium preset, slightly more compatible
      () => this.strategyConservative(inputFile, outputFile, target.h, hasAudio),
      // 3. Simple — ultrafast, stream-copy audio
      () => this.strategySimple(inputFile, outputFile, target.h, hasAudio),
      // 4. Fast re-encode — ultrafast + aac, very low quality but always produces output
      () => this.strategyFastReencode(inputFile, outputFile, target.h),
      // 5. Last resort — mpeg4 container, preserves aspect ratio, maximum compatibility
      () => this.strategyLastResort(inputFile, outputFile, target.h),
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

  async strategyOptimal(inputFile, outputFile, height, hasAudio) {
    let cmd =
      `docker exec ffmpeg-worker ffmpeg -i /tmp/videos/${inputFile} ` +
      `-vf "scale=-2:${height}" ` +
      `-c:v libx264 -preset veryfast -crf 23 -pix_fmt yuv420p -profile:v main -level 4.0 ` +
      `-movflags +faststart -g 48 -keyint_min 48 `;

    cmd += hasAudio ? `-c:a aac -b:a 128k -ar 44100 -ac 2 ` : `-an `;
    cmd += `-y /tmp/videos/${outputFile}`;

    await execAsync(cmd, { timeout: 600000 });
  }

  async strategyConservative(inputFile, outputFile, height, hasAudio) {
    let cmd =
      `docker exec ffmpeg-worker ffmpeg -i /tmp/videos/${inputFile} ` +
      `-vf "scale=-2:${height}" ` +
      `-c:v libx264 -preset medium -crf 26 -pix_fmt yuv420p ` +
      `-movflags +faststart `;

    cmd += hasAudio ? `-c:a aac -b:a 96k ` : `-an `;
    cmd += `-y /tmp/videos/${outputFile}`;

    await execAsync(cmd, { timeout: 600000 });
  }

  async strategySimple(inputFile, outputFile, height, hasAudio) {
    let cmd =
      `docker exec ffmpeg-worker ffmpeg -i /tmp/videos/${inputFile} ` +
      `-vf "scale=-2:${height}" ` +
      `-c:v libx264 -preset ultrafast -crf 30 `;

    cmd += hasAudio ? `-c:a copy ` : `-an `;
    cmd += `-y /tmp/videos/${outputFile}`;

    await execAsync(cmd, { timeout: 300000 });
  }

  async strategyFastReencode(inputFile, outputFile, height) {
    // Does NOT stream-copy — uses ultrafast + force audio encode.
    // Works even when the source audio codec is incompatible.
    const cmd =
      `docker exec ffmpeg-worker ffmpeg -i /tmp/videos/${inputFile} ` +
      `-vf "scale=-2:${height}" ` +
      `-c:v libx264 -preset ultrafast -crf 35 ` +
      `-c:a aac -b:a 64k ` +
      `-y /tmp/videos/${outputFile}`;

    await execAsync(cmd, { timeout: 300000 });
  }

  async strategyLastResort(inputFile, outputFile, height) {
    // mpeg4 container — maximum compatibility.
    // Uses -2 to preserve aspect ratio (portrait AND landscape safe).
    const cmd =
      `docker exec ffmpeg-worker ffmpeg -i /tmp/videos/${inputFile} ` +
      `-vf "scale=-2:${height}" ` +
      `-c:v mpeg4 -b:v 1000k ` +
      `-c:a mp3 -b:a 128k ` +
      `-f mp4 ` +
      `-y /tmp/videos/${outputFile}`;

    await execAsync(cmd, { timeout: 300000 });
  }

  // ---------------------------------------------------------------------------
  // ffprobe — get actual video dimensions from the shared volume
  // ---------------------------------------------------------------------------
  async probeVideo(inputFile) {
    try {
      const cmd =
        `docker exec ffmpeg-worker ffprobe ` +
        `-v quiet -print_format json -show_format -show_streams ` +
        `/tmp/videos/${inputFile}`;

      const { stdout } = await execAsync(cmd, { timeout: 30000 });
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
}

module.exports = new FFmpegService();
