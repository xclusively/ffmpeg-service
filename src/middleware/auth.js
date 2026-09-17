const jwt = require('jsonwebtoken');
const dotenv = require('dotenv');

dotenv.config();

const INTERNAL_TOKEN = process.env.INTERNAL_TOKEN;

function verifyToken(req, res, next) {
  if (INTERNAL_TOKEN && req.headers['x-internal-token'] === INTERNAL_TOKEN) {
    req.user = { internal: true };
    return next();
  }

  // ARCH-007 Phase 2: signed, short-lived internal JWT — the preferred credential
  // going forward, dual-accepted alongside the static token above during rollout.
  // Dedicated header (not Authorization): the gateway also forwards an end user's
  // own bearer token there, and this must never collide with that.
  const internalJwt = req.headers['x-internal-jwt'];
  if (internalJwt) {
    try {
      const decoded = jwt.verify(internalJwt, process.env.INTERNAL_JWT_SECRET);
      if (decoded.service) {
        req.user = { internal: true, ...decoded };
        return next();
      }
    } catch {
      /* invalid/expired — fall through */
    }
  }

  const authHeader = req.headers.authorization || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
  if (!token) {
    return res.status(401).json({ success: false, error: 'Unauthorized' });
  }

  try {
    const decoded = jwt.verify(token, process.env.JWT_ACCESS_SECRET);
    req.user = decoded;
    return next();
  } catch {
    return res.status(401).json({ success: false, error: 'Unauthorized' });
  }
}

module.exports = {
  verifyToken,
};
