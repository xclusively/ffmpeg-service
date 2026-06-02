const jwt = require('jsonwebtoken');
const dotenv = require('dotenv');

dotenv.config();

const INTERNAL_TOKEN = process.env.INTERNAL_TOKEN;

function verifyToken(req, res, next) {
  if (INTERNAL_TOKEN && req.headers['x-internal-token'] === INTERNAL_TOKEN) {
    req.user = { internal: true };
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
