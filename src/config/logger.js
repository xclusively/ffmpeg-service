const winston = require('winston');
const { getRequestId } = require('../utils/requestContext');
// ARCH-009: stamp every log line with the current request's correlation id.
const requestIdFormat = winston.format((info) => {
  const rid = getRequestId();
  if (rid) info.requestId = rid;
  return info;
});

module.exports = winston.createLogger({
  level: 'info',
  format: winston.format.combine(
    requestIdFormat(),
    winston.format.timestamp({
      format: () => {
        const now = new Date();
        // Add 5 hours and 30 minutes (5.5 hours = 19800000 milliseconds)
        const adjustedTime = new Date(now.getTime() + 5.5 * 60 * 60 * 1000);
        return adjustedTime.toISOString();
      },
    }),
    winston.format.json()
  ),
  transports: [new winston.transports.Console()],
});
