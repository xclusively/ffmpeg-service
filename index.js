const express = require('express');
// const dotenv = require("dotenv");
const path = require('path');
require('dotenv').config({
  path: path.join(__dirname, '.env'),
});
const corsMiddleware = require('./src/config/cors');
const transcodeRouter = require('./src/routes/transcode');
const logger = require('./src/config/logger');

const app = express();
const PORT = process.env.PORT || 8567;

// Middleware
app.use(corsMiddleware);
app.use(express.json({ limit: '500mb' }));
app.use(express.urlencoded({ extended: true, limit: '500mb' }));

console.log(process.env.HETZNER_BUCKET);

// Routes
app.use('/transcode', transcodeRouter);

// Health check
app.get("/health", (req, res) => {
  res.status(200).json({ status: "ok" });
});

// Error handling
// eslint-disable-next-line unused-imports/no-unused-vars
app.use((err, req, res, next) => {
  logger.error(`Unhandled error: ${err.message}`);
  res.status(500).json({
    success: false,
    error: 'Internal server error',
  });
});

app.listen(PORT, () => {
  logger.info(`FFMPEG Service running on port ${PORT}`);
});
