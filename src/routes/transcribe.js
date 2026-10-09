const express = require('express');
const router = express.Router();
const ffmpegService = require('../services/ffmpegService');
const logger = require('../config/logger');
const { verifyToken } = require('../middleware/auth');

// Protect all routes (x-internal-token or Bearer — same as /transcode, /poster).
router.use(verifyToken);

// POST /transcribe — extract audio from a video and transcribe it (whisper) for
// moderation. Body: { mediaContent: <base64 video> }
// Returns: { success, transcript, skipped?, reason? }
// Best-effort: always 200 — on any failure returns { skipped:true } so the caller
// proceeds on frames + text fields alone. Never blocks an upload.
router.post('/', async (req, res) => {
  try {
    const { mediaContent } = req.body || {};
    if (!mediaContent) {
      return res
        .status(400)
        .json({ success: false, error: 'Missing required field: mediaContent' });
    }

    const result = await ffmpegService.transcribeAudio({
      mediaContent,
      timestamp: Date.now(),
    });

    return res.json({
      success: true,
      transcript: result.transcript || '',
      skipped: !!result.skipped,
      reason: result.reason,
    });
  } catch (error) {
    // Transcription is non-critical — degrade gracefully, never fail the caller.
    logger.warn(`Transcribe route error: ${error.message}`);
    return res.json({ success: true, transcript: '', skipped: true, reason: 'transcribe_error' });
  }
});

module.exports = router;
