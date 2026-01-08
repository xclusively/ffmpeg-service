import { S3Client } from '@aws-sdk/client-s3';

export const s3Client = new S3Client({
  region: 'eu-central-1', // Region doesn’t matter for Hetzner but required
  endpoint: process.env.HETZNER_ENDPOINT,
  credentials: {
    accessKeyId: process.env.HETZNER_ACCESS_KEY,
    secretAccessKey: process.env.HETZNER_SECRET_KEY,
  },
  forcePathStyle: true,
});
