const cors = require('cors');

const corsOptions = {
  origin: [
    'http://api-gateway:3001',
    'http://post-service:3004',
    'http://localhost:3001',
    'http://localhost:3004',
  ],
  credentials: true, // Allow cookies (e.g., refreshToken)
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['X-Requested-With, Content-Type, Authorization'],
  MAX_AGE: 86400,
};

module.exports = cors(corsOptions);
