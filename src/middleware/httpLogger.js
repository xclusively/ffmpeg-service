// ARCH-009 — one structured access line per request, emitted on response finish.
// Guarantees EVERY request is greppable with its outcome + timing, even routes
// that log nothing themselves. The requestId is added automatically by the logger
// (AsyncLocalStorage), so `grep <id>` always yields at least this line:
//   {"message":"http","method":"GET","url":"/date/…","status":200,"durationMs":34,"requestId":"…"}
// Mount right AFTER the requestId middleware so it runs inside the request context.

const logger = require('../config/logger');

module.exports = function httpLogger(req, res, next) {
  const start = process.hrtime.bigint();
  res.on('finish', () => {
    const durationMs = Math.round(Number(process.hrtime.bigint() - start) / 1e6);
    logger.info('http', {
      method: req.method,
      url: req.originalUrl || req.url,
      status: res.statusCode,
      durationMs,
    });
  });
  next();
};
