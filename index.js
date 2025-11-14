const express = require("express");
const dotenv = require("dotenv");
dotenv.config();
const corsMiddleware = require("./src/config/cors");
const transcodeRouter = require("./src/routes/transcode");
const logger = require("./src/config/logger");

const app = express();
const PORT = process.env.PORT || 8567;

// Middleware
app.use(corsMiddleware);
app.use(express.json({ limit: "500mb" }));
app.use(express.urlencoded({ extended: true, limit: "500mb" }));

console.log(process.env.HETZNER_BUCKET);

// Routes
app.use("/transcode", transcodeRouter);

// Health check
app.get("/health", (req, res) => {
  res.json({
    success: true,
    service: "ffmpeg-service",
    status: "healthy",
    timestamp: new Date().toISOString(),
  });
});

// Error handling
app.use((err, req, res, next) => {
  logger.error(`Unhandled error: ${err.message}`);
  res.status(500).json({
    success: false,
    error: "Internal server error",
  });
});

app.listen(PORT, () => {
  logger.info(`FFMPEG Service running on port ${PORT}`);
});
