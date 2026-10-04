const jwt = require('jsonwebtoken');
const dotenv = require('dotenv');
const { internalCaller } = require('../utils/internalAuth');

dotenv.config();

// ARCH-007: trusted internal caller (shared module) — signed service JWT via
// x-internal-jwt (gateway) or Authorization: Bearer (direct service-to-service),
// or the legacy static x-internal-token in INTERNAL_AUTH_MODE=dual only.
function verifyToken(req, res, next) {
  const caller = internalCaller(req);
  if (caller) {
    req.user = { internal: true, ...caller };
    req.internalCaller = caller;
    return next();
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
