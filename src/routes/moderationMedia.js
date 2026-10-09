const express = require('express');
const router = express.Router();
const ffmpegService = require('../services/ffmpegService');
const logger = require('../config/logger');
const { verifyToken } = require('../middleware/auth');

// Protect all routes (x-internal-token or Bearer — same as /transcode, /poster).
router.use(verifyToken);

// POST /frames — extract sampled frames from a video for moderation.
// Body: { mediaContent: <base64 video>, maxFrames?, fps?, startSeconds?, durationSeconds? }
// Returns: { success, frames: [<base64 jpg>...], width, height, durationSeconds }
// Throws 500 on hard failure so the caller (verify-service) treats it as a
// moderation error and fail-safes (queues for review) instead of passing an
// un-inspected video.
router.post('/', async (req, res) => {
  try {
    const { mediaContent, maxFrames, fps, startSeconds, durationSeconds } = req.body || {};
    if (!mediaContent) {
      return res
        .status(400)
        .json({ success: false, error: 'Missing required field: mediaContent' });
    }

    const result = await ffmpegService.extractFrames({
      mediaContent,
      maxFrames: Number(maxFrames) > 0 ? Number(maxFrames) : 20,
      fps: Number(fps) > 0 ? Number(fps) : undefined,
      startSeconds: Number.isFinite(Number(startSeconds)) ? Number(startSeconds) : undefined,
      durationSeconds: Number(durationSeconds) > 0 ? Number(durationSeconds) : undefined,
      timestamp: Date.now(),
    });

    return res.json({
      success: true,
      frames: result.frames,
      width: result.width,
      height: result.height,
      durationSeconds: result.durationSeconds,
    });
  } catch (error) {
    logger.error(`Frames route error: ${error.message}`);
    return res.status(500).json({ success: false, error: 'Failed to extract frames' });
  }
});

module.exports = router;
