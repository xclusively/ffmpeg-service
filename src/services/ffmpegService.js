const { exec } = require("child_process");
const util = require("util");
const fs = require("fs");
const path = require("path");
const fetch = require("node-fetch");
const Queue = require("bull");
const dropboxService = require("./dropboxService");
const logger = require("../config/logger");

const execAsync = util.promisify(exec);
const SHARED_VIDEO_PATH = "/tmp/videos";

// Create Redis queue
const transcodeQueue = new Queue("video transcoding", {
  redis: {
    host: process.env.REDIS_HOST || "redis",
    port: process.env.REDIS_PORT || 6379,
  },
});

class FFmpegService {
  constructor() {
    this.setupQueue();
  }

  setupQueue() {
    // Process queue with concurrency of 1 (one user at a time)
    transcodeQueue.process("transcode-user", 1, async (job) => {
      return await this.processVideoVariants(job.data);
    });

    // Queue event listeners
    transcodeQueue.on("completed", (job, result) => {
      logger.info(`Job ${job.id} completed for ${job.data.fileName}`);
    });

    transcodeQueue.on("failed", (job, err) => {
      logger.error(
        `Job ${job.id} failed for ${job.data.fileName}: ${err.message}`
      );
    });

    transcodeQueue.on("stalled", (job) => {
      logger.warn(`Job ${job.id} stalled for ${job.data.fileName}`);
    });
  }

  // Public method - adds job to queue
  async queueTranscoding(options) {
    const job = await transcodeQueue.add("transcode-user", options, {
      priority: 1,
      attempts: 3,
      backoff: {
        type: "exponential",
        delay: 2000,
      },
      removeOnComplete: 10, // Keep last 10 completed jobs
      removeOnFail: 5, // Keep last 5 failed jobs
    });

    logger.info(`Queued transcoding job ${job.id} for ${options.fileName}`);
    return { jobId: job.id, status: "queued" };
  }

  // Private method - actual processing (now with concurrent resolutions)
  async processVideoVariants(options) {
    const { originalUrl, fileName, baseName, timestamp, dbxAccessToken } =
      options;
    let tempFiles = [];

    try {
      logger.info(
        `Starting transcoding process for ${fileName} (Job processing)`
      );

      // 1. Download original video from Dropbox
      const inputBuffer = await this.downloadFromDropbox(originalUrl);

      // 2. Create temp input file
      const tempId = `${timestamp}-${Math.random().toString(36).substring(7)}`;
      const inputFile = `input-${tempId}.mp4`;
      const inputPath = path.join(SHARED_VIDEO_PATH, inputFile);

      if (!fs.existsSync(SHARED_VIDEO_PATH)) {
        fs.mkdirSync(SHARED_VIDEO_PATH, { recursive: true });
      }
      fs.writeFileSync(inputPath, inputBuffer);
      tempFiles.push(inputPath);

      // 3. Probe video
      const probe = await this.probeVideo(inputFile);
      logger.info(
        `Video probe: ${probe.width}x${probe.height}, audio=${probe.hasAudio}, duration=${probe.duration}s`
      );

      // 4. Define variant paths
      const paths = {
        p1080: `/${timestamp}-${baseName}-1080p.mp4`,
        p720: `/${timestamp}-${baseName}-720p.mp4`,
        p480: `/${timestamp}-${baseName}-480p.mp4`,
        p360: `/${timestamp}-${baseName}-360p.mp4`,
      };

      // 5. Get optimal targets
      const targets = this.getOptimalTargets(probe.width, probe.height, paths);

      // 6. ✅ Process ALL variants CONCURRENTLY (for same user)
      const variantPromises = targets.map((target) =>
        this.processVariantWithFallbacks(
          target,
          inputFile,
          tempId,
          probe.hasAudio,
          [...tempFiles], // Copy array to avoid conflicts
          dbxAccessToken
        )
      );

      // Wait for all variants to complete
      await Promise.allSettled(variantPromises);

      logger.info(`Transcoding completed successfully for ${fileName}`);
      return { success: true, variants: targets.length };
    } catch (error) {
      logger.error(`Transcoding process failed: ${error.message}`);
      throw error;
    } finally {
      // Cleanup temp files
      this.cleanupTempFiles(tempFiles);
    }
  }

  // Get queue status
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

  // Get specific job status
  async getJobStatus(jobId) {
    const job = await transcodeQueue.getJob(jobId);
    if (!job) {
      return { status: "not_found" };
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

  async downloadFromDropbox(url) {
    try {
      const response = await fetch(url);
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }
      return Buffer.from(await response.arrayBuffer());
    } catch (error) {
      logger.error(`Failed to download from Dropbox: ${error.message}`);
      throw error;
    }
  }

  async probeVideo(inputFile) {
    try {
      const cmd = `docker exec ffmpeg-service-ffmpeg-worker-1 ffprobe -v quiet -print-format json -show-format -show-streams /tmp/videos/${inputFile}`;
      const { stdout } = await execAsync(cmd, { timeout: 30000 });
      const probe = JSON.parse(stdout);

      const videoStream = probe.streams.find((s) => s.codec_type === "video");
      if (!videoStream) {
        throw new Error("No video stream found");
      }

      return {
        height: videoStream.height || 720,
        width: videoStream.width || 1280,
        duration: parseFloat(probe.format?.duration || 0),
        hasAudio: probe.streams.some((s) => s.codec_type === "audio"),
        codec: videoStream.codec_name || "unknown",
        fps: parseFloat(videoStream.r_frame_rate?.split("/")[0] || 30),
      };
    } catch (error) {
      logger.error(`Video probe failed: ${error.message}`);
      return {
        height: 720,
        width: 1280,
        duration: 0,
        hasAudio: false,
        codec: "unknown",
        fps: 30,
      };
    }
  }

  getOptimalTargets(width, height, paths) {
    const targets = [];

    if (height > 1080 || width > 1920) {
      targets.push({ h: 1080, key: "p1080", path: paths.p1080 });
    }
    if (height > 720 || width > 1280) {
      targets.push({ h: 720, key: "p720", path: paths.p720 });
    }
    if (height > 480 || width > 854) {
      targets.push({ h: 480, key: "p480", path: paths.p480 });
    }
    if (height > 360 || width > 640) {
      targets.push({ h: 360, key: "p360", path: paths.p360 });
    }

    logger.info(
      `Original: ${width}x${height} -> Creating variants: ${targets
        .map((t) => t.h + "p")
        .join(", ")}`
    );

    return targets;
  }

  async processVariantWithFallbacks(
    target,
    inputFile,
    tempId,
    hasAudio,
    tempFiles,
    dbxAccessToken
  ) {
    logger.info(`Transcoding ${target.h}p`);

    // Create unique output file for this variant
    const outputFile = `output-${tempId}-${target.h}p.mp4`;
    const outputPath = path.join(SHARED_VIDEO_PATH, outputFile);
    tempFiles.push(outputPath);

    const strategies = [
      () => this.transcodeOptimal(inputFile, outputFile, target.h, hasAudio),
      () =>
        this.transcodeConservative(inputFile, outputFile, target.h, hasAudio),
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
            await dropboxService.uploadBuffer(
              transcodedBuffer,
              target.path,
              dbxAccessToken
            );

            logger.info(
              `Uploaded ${target.h}p ${target.path} (strategy ${i + 1}, size: ${
                stats.size
              } bytes)`
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

  // Transcoding strategies (unchanged)
  async transcodeOptimal(inputFile, outputFile, height, hasAudio) {
    let cmd =
      `docker exec ffmpeg-service-ffmpeg-worker-1 ffmpeg -i /tmp/videos/${inputFile} ` +
      `-vf "scale=-2:${height}:force_original_aspect_ratio=decrease:force_divisible_by=2" ` +
      `-c:v libx264 -preset veryfast -crf 23 -pix_fmt yuv420p ` +
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
      `docker exec ffmpeg-service-ffmpeg-worker-1 ffmpeg -i /tmp/videos/${inputFile} ` +
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
      `docker exec ffmpeg-service-ffmpeg-worker-1 ffmpeg -i /tmp/videos/${inputFile} ` +
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
      `docker exec ffmpeg-service-ffmpeg-worker-1 ffmpeg -i /tmp/videos/${inputFile} ` +
      `-vf "scale=-1:${height}" ` +
      `-c copy ` +
      `-y /tmp/videos/${outputFile}`;
    await execAsync(cmd, { timeout: 300000 });
  }

  async transcodeLastResort(inputFile, outputFile, height) {
    const cmd =
      `docker exec ffmpeg-service-ffmpeg-worker-1 ffmpeg -i /tmp/videos/${inputFile} ` +
      `-vf "scale=${(height * 16) / 9}:${height}" ` +
      `-c:v mpeg4 -b:v 1000k ` +
      `-c:a mp3 -b:a 128k ` +
      `-f mp4 ` +
      `-y /tmp/videos/${outputFile}`;
    await execAsync(cmd, { timeout: 300000 });
  }

  cleanupTempFiles(tempFiles) {
    tempFiles.forEach((filePath) => {
      try {
        if (fs.existsSync(filePath)) {
          fs.unlinkSync(filePath);
        }
      } catch (e) {
        logger.warn(`Failed to cleanup temp file ${filePath}: ${e.message}`);
      }
    });
  }
}

module.exports = new FFmpegService();
