// ARCH-009 — correlation id middleware. Mount FIRST so every log line for the
// request (and every downstream service it fans out to) shares one id.
//
// Accepts an inbound `x-request-id` (so a caller — or the gateway, for downstream
// hops — can supply one) after sanitizing it, otherwise generates a uuid. Then:
//   - stamps req.requestId,
//   - rewrites req.headers['x-request-id'] to the canonical id so it propagates
//     downstream (forwardRequest forwards {...req.headers}),
//   - echoes it back as the `X-Request-Id` response header (hand it to support),
//   - runs the rest of the request inside the AsyncLocalStorage context.

const { randomUUID } = require('crypto');
const { runWithContext } = require('../utils/requestContext');

const HEADER = 'x-request-id';
const MAX_LEN = 128;

// Only accept a log-safe, bounded inbound id; anything else → generate a fresh one.
function sanitize(value) {
  if (typeof value !== 'string') return null;
  const s = value.trim();
  if (!s || s.length > MAX_LEN || !/^[\w.-]+$/.test(s)) return null;
  return s;
}

module.exports = function requestId(req, res, next) {
  const id = sanitize(req.headers[HEADER]) || randomUUID();
  req.requestId = id;
  req.headers[HEADER] = id; // canonical value forwarded to downstream services
  res.setHeader('X-Request-Id', id);
  runWithContext({ requestId: id }, next);
};
