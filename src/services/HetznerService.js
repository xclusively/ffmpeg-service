const logger = require('../config/logger');
const { s3Client } = require('../utils/s3Client');
const { PutObjectCommand } = require('@aws-sdk/client-s3');

class HetznerService {
  /**
   * Upload a buffer directly to Hetzner S3 via AWS SDK.
   * @param {Buffer} buffer - The file content
   * @param {string} key    - The S3 object key (e.g. "public/uploads/user-ts-720p.mp4")
   */
  async uploadBuffer(buffer, key) {
    try {
      logger.info(`Uploading transcoded variant to Hetzner S3: ${key}`);

      const command = new PutObjectCommand({
        Bucket: process.env.HETZNER_BUCKET,
        Key: key,
        Body: buffer,
        ContentType: 'video/mp4',
      });

      await s3Client.send(command);
      logger.info(`✅ Uploaded ${key} to Hetzner S3 (${buffer.length} bytes)`);
      return key;
    } catch (error) {
      logger.error(`❌ Hetzner S3 upload failed for ${key}: ${error.message}`);
      throw error;
    }
  }
}

module.exports = new HetznerService();
