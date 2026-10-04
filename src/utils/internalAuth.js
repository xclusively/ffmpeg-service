// ARCH-007 completion — the one place this service decides "is this caller a trusted
// internal service?" and "what credential do I send when I call one?".
//
// INTERNAL_AUTH_MODE:
//   dual (default) — send signed x-internal-jwt AND the legacy static x-internal-token;
//                    accept either. Today's behaviour, safe while services redeploy
//                    independently.
//   jwt            — send + accept the signed JWT only. The static token is rejected.
//                    Target state once every service runs this code.
const jwt = require('jsonwebtoken');

const SERVICE_NAME = 'ffmpeg-service';
const TTL_SECONDS = 5 * 60;
const REFRESH_BUFFER_SECONDS = 30;

let cached = null; // { token, expiresAt }

const mode = () => (process.env.INTERNAL_AUTH_MODE === 'jwt' ? 'jwt' : 'dual');

// Boot guard (replaces the Phase 1 INTERNAL_TOKEN-only check): refuse to run with the
// internal trust boundary unenforceable.
function assertInternalAuthConfigured() {
  const missing = mode() === 'jwt' ? 'INTERNAL_JWT_SECRET' : 'INTERNAL_TOKEN';
  if (!process.env[missing]) {
    // eslint-disable-next-line no-console
    console.error(`[ARCH-007] CRITICAL: ${missing} is not set — refusing to start.`);
    process.exit(1);
  }
}

function mintInternalJwt() {
  if (!process.env.INTERNAL_JWT_SECRET) return null;
  const now = Math.floor(Date.now() / 1000);
  if (cached && cached.expiresAt - now > REFRESH_BUFFER_SECONDS) return cached.token;
  const token = jwt.sign({ service: SERVICE_NAME }, process.env.INTERNAL_JWT_SECRET, {
    expiresIn: TTL_SECONDS,
  });
  cached = { token, expiresAt: now + TTL_SECONDS };
  return token;
}

// Headers to attach to every outbound service-to-service call.
function internalHeaders() {
  const headers = {};
  const token = mintInternalJwt();
  if (token) headers['x-internal-jwt'] = token;
  if (mode() === 'dual' && process.env.INTERNAL_TOKEN) {
    headers['x-internal-token'] = process.env.INTERNAL_TOKEN;
  }
  return headers;
}

function verifyServiceJwt(token) {
  if (!token || !process.env.INTERNAL_JWT_SECRET) return null;
  try {
    const decoded = jwt.verify(token, process.env.INTERNAL_JWT_SECRET);
    return decoded && decoded.service ? decoded : null;
  } catch {
    return null;
  }
}

// The legacy static token is honoured only in dual mode.
function isValidStaticToken(value) {
  if (mode() !== 'dual') return false;
  const staticToken = process.env.INTERNAL_TOKEN;
  return Boolean(staticToken && value && value === staticToken);
}

// Returns the caller's decoded claims ({ service, ... }) when trusted, else null.
function internalCaller(req) {
  const headers = (req && req.headers) || {};
  const fromHeader = verifyServiceJwt(headers['x-internal-jwt']);
  if (fromHeader) return fromHeader;

  const authHeader = headers.authorization || '';
  if (authHeader.startsWith('Bearer ')) {
    const fromBearer = verifyServiceJwt(authHeader.slice(7));
    if (fromBearer) return fromBearer;
  }

  if (isValidStaticToken(headers['x-internal-token'])) {
    return { service: 'legacy-static-token' };
  }
  return null;
}

const isInternalRequest = (req) => internalCaller(req) !== null;

// Express middleware for internal-only routers: fail closed.
function requireInternal(req, res, next) {
  const caller = internalCaller(req);
  if (!caller) return res.status(403).json({ error: 'Forbidden' });
  req.internalCaller = caller;
  return next();
}

const _resetCache = () => {
  cached = null;
};

// ARCH-007 D12. The gateway attaches its internal credential to EVERY proxied end-user
// request, so "internal" alone only proves "came through the gateway". Routes meant
// for other services only (never proxied for a client) require a caller that is
// internal AND not the gateway.
const GATEWAY_SERVICE = 'api-gateway';
function isServiceCaller(req) {
  const caller = internalCaller(req);
  return caller !== null && caller.service !== GATEWAY_SERVICE;
}
function requireServiceCaller(req, res, next) {
  const caller = internalCaller(req);
  if (!caller || caller.service === GATEWAY_SERVICE) {
    return res.status(403).json({ error: 'Forbidden' });
  }
  req.internalCaller = caller;
  return next();
}

// ARCH-007 D12. Identity headers are asserted by the gateway (from a verified token)
// or by a trusted service. From anyone else they are forgeable — drop them before any
// route can read them.
const IDENTITY_HEADERS = ['x-user-id', 'x-admin-id'];
function stripUntrustedIdentityHeaders(req, _res, next) {
  if (!internalCaller(req)) {
    for (const h of IDENTITY_HEADERS) delete req.headers[h];
  }
  return next();
}

module.exports = {
  requireServiceCaller,
  stripUntrustedIdentityHeaders,
  isServiceCaller,
  assertInternalAuthConfigured,
  internalHeaders,
  internalCaller,
  isInternalRequest,
  isValidStaticToken,
  verifyServiceJwt,
  requireInternal,
  mintInternalJwt,
  _resetCache,
};
