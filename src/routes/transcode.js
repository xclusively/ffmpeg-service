const express = require('express');
const router = express.Router();
const ffmpegService = require('../services/ffmpegService');
const logger = require('../config/logger');

// POST /transcode - Queue transcoding job
router.post('/', async (req, res) => {
  try {
    const { fileKey, mediaContent } = req.body;

    if (!fileKey || !mediaContent) {
      return res.status(400).json({
        success: false,
        error: 'Missing required fields: fileKey, mediaContent',
      });
    }

    logger.info(`Transcoding request received for ${fileKey}`);

    // Add to queue instead of processing immediately
    const result = await ffmpegService.queueTranscoding({
      fileKey,
      mediaContent,
      timestamp: Date.now(),
    });

    res.json({
      success: true,
      message: 'Transcoding job queued successfully',
      jobId: result.jobId,
      status: result.status,
      fileKey,
    });
  } catch (error) {
    logger.error(`Transcode route error: ${error.message}`);
    res.status(500).json({
      success: false,
      error: 'Failed to queue transcoding job',
    });
  }
});

// GET /status/:jobId - Check job status
router.get('/status/:jobId', async (req, res) => {
  try {
    const { jobId } = req.params;
    const status = await ffmpegService.getJobStatus(jobId);

    res.json({
      success: true,
      job: status,
    });
  } catch (error) {
    logger.error(`Status check error: ${error.message}`);
    res.status(500).json({
      success: false,
      error: 'Failed to get job status',
    });
  }
});

// GET /queue - Get queue status
router.get('/queue', async (req, res) => {
  try {
    const status = await ffmpegService.getQueueStatus();
    res.json({
      success: true,
      queue: status,
    });
  } catch (error) {
    logger.error(`Queue status error: ${error.message}`);
    res.status(500).json({
      success: false,
      error: 'Failed to get queue status',
    });
  }
});

// GET /health - Health check
router.get('/health', (req, res) => {
  res.json({
    success: true,
    service: 'ffmpeg-service',
    status: 'healthy',
    timestamp: new Date().toISOString(),
  });
});

module.exports = router;
