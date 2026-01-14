const { exec } = require('child_process');
const util = require('util');
const fs = require('fs');
const path = require('path');
const Queue = require('bull');
const HetznerService = require('./HetznerService');
const logger = require('../config/logger');
const { Readable } = require('stream');

const execAsync = util.promisify(exec);
const SHARED_VIDEO_PATH = '/tmp/videos';

const transcodeQueue = new Queue('video transcoding', {
  redis: {
    host: process.env.REDIS_HOST || 'host.docker.internal',
    port: process.env.REDIS_PORT || 6379,
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

  setupQueue() {
    transcodeQueue.process('transcode-user', 1, async (job) => {
      return await this.processVideoVariants(job.data);
    });

    // eslint-disable-next-line unused-imports/no-unused-vars
    transcodeQueue.on('completed', (job, result) => {
      logger.info(`Job ${job.id} completed for ${job.data.fileKey}`);
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
      backoff: {
        type: 'exponential',
        delay: 2000,
      },
      removeOnComplete: 10,
      removeOnFail: 5,
    });

    logger.info(`Queued transcoding job ${job.id} for ${options.fileKey}`);
    return { jobId: job.id, status: 'queued' };
  }

  async processVideoVariants(options) {
    const { fileKey, mediaContent, timestamp = Date.now() } = options;
    // let tempFiles = [];
    let inputPath = null;

    try {
      logger.info(`Starting transcoding process for ${fileKey} (Job processing)`);

      // 1. Download and create input file as stream
      const tempId = `${timestamp}-${Math.random().toString(36).substring(7)}`;
      const inputFile = `input-${tempId}.mp4`;
      inputPath = path.join(SHARED_VIDEO_PATH, inputFile);

      if (!fs.existsSync(SHARED_VIDEO_PATH)) {
        fs.mkdirSync(SHARED_VIDEO_PATH, { recursive: true });
      }

      // Download as stream and save to file
      const buffer = Buffer.from(mediaContent, 'base64');
      await new Promise((resolve, reject) => {
        const readable = Readable.from(buffer);
        const writeStream = fs.createWriteStream(inputPath);
        readable.pipe(writeStream);
        readable.on('error', reject);
        writeStream.on('finish', resolve);
        writeStream.on('error', reject);
      });

      // 2. Probe video
      const probe = await this.probeVideo(inputFile);
      logger.info(`Video probe: ${probe.width}x${probe.height}, audio=${probe.hasAudio}`);

      // 3. Define targets and output paths
      const paths = {
        p1080: `${fileKey.replace('original', '1080p')}`,
        p720: `${fileKey.replace('original', '720p')}`,
        p480: `${fileKey.replace('original', '480p')}`,
        p360: `${fileKey.replace('original', '360p')}`,
      };
      const targets = this.getOptimalTargets(probe.width, probe.height, paths);

      // 4. Process variants with individual cleanup
      const variantPromises = targets.map(async (target) => {
        const outputFile = `output-${tempId}-${target.h}p.mp4`;
        const outputPath = path.join(SHARED_VIDEO_PATH, outputFile);

        try {
          await this.processVariantWithFallbacks(
            target,
            inputFile,
            tempId,
            probe.hasAudio,
            outputPath
          );
        } finally {
          this.cleanupSingleFile(outputPath);
        }
      });

      await Promise.allSettled(variantPromises);
      logger.info(`Transcoding completed successfully for ${fileKey}`);
      return { success: true, variants: targets.length };
    } catch (error) {
      logger.error(`Transcoding process failed: ${error.message}`);
      throw error;
    } finally {
      if (inputPath) {
        this.cleanupSingleFile(inputPath);
      }
    }
  }

  async getQueueStatus() {
    const waiting = await transcodeQueue.getWaiting();
    const active = await transcodeQueue.getActive();
    const completed = await transcodeQueue.getCompleted();
    const failed = await transcodeQueue.getFailed();

    return {
      waiting: waiting.length,
      active: active.length,
      completed: completed.length,
      failed: failed.length,
    };
  }

  async getJobStatus(jobId) {
    const job = await transcodeQueue.getJob(jobId);
    if (!job) {
      return { status: 'not_found' };
    }

    return {
      id: job.id,
      status: await job.getState(),
      progress: job.progress(),
      data: job.data,
      createdAt: new Date(job.timestamp),
      processedAt: job.processedOn ? new Date(job.processedOn) : null,
      finishedAt: job.finishedOn ? new Date(job.finishedOn) : null,
    };
  }

  async probeVideo(inputFile) {
    try {
      const cmd = `docker exec ffmpeg-worker ffprobe -v quiet -print-format json -show-format -show-streams /tmp/videos/${inputFile}`;
      const { stdout } = await execAsync(cmd, { timeout: 30000 });
      const probe = JSON.parse(stdout);

      const videoStream = probe.streams.find((s) => s.codec_type === 'video');
      if (!videoStream) {
        throw new Error('No video stream found');
      }

      return {
        height: videoStream.height || 720,
        width: videoStream.width || 1280,
        duration: parseFloat(probe.format?.duration || 0),
        hasAudio: probe.streams.some((s) => s.codec_type === 'audio'),
        codec: videoStream.codec_name || 'unknown',
        fps: parseFloat(videoStream.r_frame_rate?.split('/')[0] || 30),
      };
    } catch (error) {
      logger.error(`Video probe failed: ${error.message}`);
      return {
        height: 720,
        width: 1280,
        duration: 0,
        hasAudio: false,
        codec: 'unknown',
        fps: 30,
      };
    }
  }

  getOptimalTargets(width, height, paths) {
    const targets = [];

    if (height > 1080 || width > 1920) {
      targets.push({ h: 1080, key: 'p1080', path: paths.p1080 });
    }
    if (height > 720 || width > 1280) {
      targets.push({ h: 720, key: 'p720', path: paths.p720 });
    }
    if (height > 480 || width > 854) {
      targets.push({ h: 480, key: 'p480', path: paths.p480 });
    }
    if (height > 360 || width > 640) {
      targets.push({ h: 360, key: 'p360', path: paths.p360 });
    }

    logger.info(
      `Original: ${width}x${height} -> Creating variants: ${targets
        .map((t) => t.h + 'p')
        .join(', ')}`
    );

    return targets;
  }

  async processVariantWithFallbacks(target, inputFile, tempId, hasAudio, outputPath) {
    logger.info(`Transcoding ${target.h}p`);

    const outputFile = path.basename(outputPath);

    const strategies = [
      () => this.transcodeOptimal(inputFile, outputFile, target.h, hasAudio),
      () => this.transcodeConservative(inputFile, outputFile, target.h, hasAudio),
      () => this.transcodeSimple(inputFile, outputFile, target.h, hasAudio),
      () => this.transcodeCopy(inputFile, outputFile, target.h),
      () => this.transcodeLastResort(inputFile, outputFile, target.h),
    ];

    for (let i = 0; i < strategies.length; i++) {
      try {
        await strategies[i]();

        if (fs.existsSync(outputPath)) {
          const stats = fs.statSync(outputPath);
          if (stats.size > 1024) {
            const transcodedBuffer = fs.readFileSync(outputPath);
            await HetznerService.uploadBuffer(transcodedBuffer, target.path);

            logger.info(
              `Uploaded ${target.h}p ${target.path} (strategy ${i + 1}, size: ${stats.size} bytes)`
            );
            return;
          }
        }
      } catch (e) {
        logger.warn(`Strategy ${i + 1} failed for ${target.h}p: ${e.message}`);
      }
    }

    logger.error(`All strategies failed for ${target.h}p`);
  }

  async transcodeOptimal(inputFile, outputFile, height, hasAudio) {
    let cmd =
      `docker exec ffmpeg-worker ffmpeg -i /tmp/videos/${inputFile} ` +
      `-vf "scale=-2:${height}:force_original_aspect_ratio=decrease:force_divisible_by=2" ` +
      `-c:v libx264 -preset veryfast -crf 23 -pix_fmt yuv420p -profile:v main -level 4.0 ` +
      `-movflags +faststart -g 48 -keyint_min 48 `;

    if (hasAudio) {
      cmd += `-c:a aac -b:a 128k -ar 44100 -ac 2 `;
    } else {
      cmd += `-an `;
    }

    cmd += `-y /tmp/videos/${outputFile}`;
    await execAsync(cmd, { timeout: 600000 });
  }

  async transcodeConservative(inputFile, outputFile, height, hasAudio) {
    let cmd =
      `docker exec ffmpeg-worker ffmpeg -i /tmp/videos/${inputFile} ` +
      `-vf "scale=trunc(oh*a/2)*2:${height}" ` +
      `-c:v libx264 -preset medium -crf 25 -pix_fmt yuv420p ` +
      `-movflags +faststart `;

    if (hasAudio) {
      cmd += `-c:a aac -b:a 96k `;
    } else {
      cmd += `-an `;
    }

    cmd += `-y /tmp/videos/${outputFile}`;
    await execAsync(cmd, { timeout: 600000 });
  }

  async transcodeSimple(inputFile, outputFile, height, hasAudio) {
    let cmd =
      `docker exec ffmpeg-worker ffmpeg -i /tmp/videos/${inputFile} ` +
      `-vf "scale=-1:${height}" ` +
      `-c:v libx264 -preset ultrafast -crf 30 `;

    if (hasAudio) {
      cmd += `-c:a copy `;
    } else {
      cmd += `-an `;
    }

    cmd += `-y /tmp/videos/${outputFile}`;
    await execAsync(cmd, { timeout: 300000 });
  }

  async transcodeCopy(inputFile, outputFile, height) {
    const cmd =
      `docker exec ffmpeg-worker ffmpeg -i /tmp/videos/${inputFile} ` +
      `-vf "scale=-1:${height}" ` +
      `-c copy ` +
      `-y /tmp/videos/${outputFile}`;
    await execAsync(cmd, { timeout: 300000 });
  }

  async transcodeLastResort(inputFile, outputFile, height) {
    const cmd =
      `docker exec ffmpeg-worker ffmpeg -i /tmp/videos/${inputFile} ` +
      `-vf "scale=${(height * 16) / 9}:${height}" ` +
      `-c:v mpeg4 -b:v 1000k ` +
      `-c:a mp3 -b:a 128k ` +
      `-f mp4 ` +
      `-y /tmp/videos/${outputFile}`;
    await execAsync(cmd, { timeout: 300000 });
  }

  cleanupSingleFile(filePath) {
    try {
      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
        logger.debug(`Cleaned up temp file: ${filePath}`);
      }
    } catch (e) {
      logger.warn(`Failed to cleanup temp file ${filePath}: ${e.message}`);
    }
  }

  // cleanupTempFiles(tempFiles) {
  //   tempFiles.forEach((filePath) => this.cleanupSingleFile(filePath));
  // }
}

module.exports = new FFmpegService();
