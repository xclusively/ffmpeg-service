const { S3Client } = require('@aws-sdk/client-s3');

const s3Client = new S3Client({
  region: 'eu-central-1', // Required by SDK but Hetzner ignores it
  endpoint: process.env.HETZNER_ENDPOINT,
  credentials: {
    accessKeyId: process.env.HETZNER_ACCESS_KEY,
    secretAccessKey: process.env.HETZNER_SECRET_KEY,
  },
  forcePathStyle: true,
});

module.exports = { s3Client };
