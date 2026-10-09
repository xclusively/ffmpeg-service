const express = require('express');
const router = express.Router();
const ffmpegService = require('../services/ffmpegService');
const logger = require('../config/logger');
const { verifyToken } = require('../middleware/auth');

// Protect all routes (x-internal-token or Bearer — same as /transcode).
router.use(verifyToken);

// POST /poster — SYNCHRONOUS poster-frame extraction.
// Body: { mediaContent: <base64 video>, width?: number }
// Returns: { success, poster: <base64 webp>, contentType, width, height }
// Best-effort: on failure returns 200 { success:false, poster:null } so the caller
// can proceed without a poster rather than failing the upload.
router.post('/', async (req, res) => {
  try {
    const { mediaContent, width } = req.body;
    if (!mediaContent) {
      return res
        .status(400)
        .json({ success: false, error: 'Missing required field: mediaContent' });
    }

    const result = await ffmpegService.generatePoster({
      mediaContent,
      width: Number(width) > 0 ? Number(width) : 720,
      timestamp: Date.now(),
    });

    if (!result) {
      return res.json({ success: false, poster: null });
    }

    return res.json({
      success: true,
      poster: result.poster,
      contentType: result.contentType,
      width: result.width,
      height: result.height,
    });
  } catch (error) {
    logger.error(`Poster route error: ${error.message}`);
    return res.status(500).json({ success: false, error: 'Failed to generate poster' });
  }
});

module.exports = router;
