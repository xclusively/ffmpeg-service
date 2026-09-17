const path = require('path');
// Must run BEFORE requiring infisical-loader — the loader reads its own
// INFISICAL_* bootstrap creds from process.env at require time, and in a local
// bare `node index.js` run those only exist after dotenv loads .env. (In
// docker/dev/prod they're already real container env vars, so this ordering
// bug was silent there — only local runs hit it.)
require('dotenv').config({
  path: path.join(__dirname, '.env'),
});

require('./infisical-loader')
  .bootstrap()
  .then(() => {
    // ARCH-007: fail closed, not open. Without INTERNAL_TOKEN this service can't
    // tell gateway traffic from a direct network caller — refuse to boot rather
    // than run with the internal trust boundary silently gone.
    if (!process.env.INTERNAL_TOKEN) {
      // eslint-disable-next-line no-console
      console.error('[ARCH-007] CRITICAL: INTERNAL_TOKEN is not set — refusing to start.');
      process.exit(1);
    }
    const express = require('express');
    const corsMiddleware = require('./src/config/cors');
    const transcodeRouter = require('./src/routes/transcode');
    const logger = require('./src/config/logger');

    const app = express();
    // ARCH-009: correlation id — mount FIRST so every log line + downstream hop shares one id.
    app.use(require('./src/middleware/requestId'));
    // ARCH-009: one access line per request (method/url/status/durationMs + id).
    app.use(require('./src/middleware/httpLogger'));
    const PORT = process.env.PORT || 8567;

    // Middleware
    app.use(corsMiddleware);
    app.use(express.json({ limit: '500mb' }));
    app.use(express.urlencoded({ extended: true, limit: '500mb' }));

    // Routes
    app.use('/transcode', transcodeRouter);

    // Health check
    app.get('/health', (req, res) => {
      res.status(200).json({ status: 'ok' });
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
  })
  .catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
