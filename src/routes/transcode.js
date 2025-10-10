const express = require("express");
const router = express.Router();
const ffmpegService = require("../services/ffmpegService");
const logger = require("../config/logger");

// POST /transcode - Main transcoding endpoint
router.post("/", async (req, res) => {
  try {
    const { originalUrl, fileName, baseName, timestamp, dbxAccessToken } =
      req.body;

    // Validate required fields
    if (!originalUrl || !fileName || !dbxAccessToken) {
      return res.status(400).json({
        success: false,
        error: "Missing required fields: originalUrl, fileName, dbxAccessToken",
      });
    }

    logger.info(`Transcoding request received for ${fileName}`);

    // Start background transcoding (fire and forget)
    ffmpegService
      .processVideoVariants({
        originalUrl,
        fileName,
        baseName: baseName || fileName.split(".")[0],
        timestamp: timestamp || Date.now(),
        dbxAccessToken,
      })
      .catch((error) => {
        logger.error(
          `Background transcoding failed for ${fileName}: ${error.message}`
        );
      });

    // Return immediate success response
    res.json({
      success: true,
      message: "Transcoding started in background",
      fileName,
    });
  } catch (error) {
    logger.error(`Transcode route error: ${error.message}`);
    res.status(500).json({
      success: false,
      error: "Failed to start transcoding process",
    });
  }
});

// GET /status/:jobId - Check transcoding status (future feature)
router.get("/status/:jobId", async (req, res) => {
  // TODO: Implement job status tracking
  res.json({
    success: true,
    status: "not_implemented",
    message: "Status tracking coming soon",
  });
});

// GET /health - Health check
router.get("/health", (req, res) => {
  res.json({
    success: true,
    service: "ffmpeg-service",
    status: "healthy",
    timestamp: new Date().toISOString(),
  });
});

module.exports = router;
