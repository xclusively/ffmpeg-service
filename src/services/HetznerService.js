const fetch = require("node-fetch");
const logger = require("../config/logger");
const { s3Client } = require("../utils/s3Client");
const { PutObjectCommand } = require("@aws-sdk/client-s3");

class HetznerService {
  async uploadBuffer(buffer, pathLower) {
    try {
      logger.info(`Uploading ${pathLower} to Hetzner...`);

      const uploadUrlResponse = await fetch(
        `http://auth-service:3002/URLs/upload-url`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            fileKey: pathLower,
            fileType: "application/octet-stream",
            expiresIn: 600,
          }),
        }
      );

      if (!uploadUrlResponse.ok) {
        throw new Error(
          `Failed to get upload URL: ${uploadUrlResponse.statusText}`
        );
      }

      const { uploadUrl, publicUrl } = await uploadUrlResponse.json();
      const bucket = process.env.HETZNER_BUCKET;
      logger.info(`Received upload URL from auth-service.`, {
        bucket,
      });
      const command = new PutObjectCommand({
        Bucket: process.env.HETZNER_BUCKET,
        Key: pathLower,
        Body: buffer,
        ContentType: "application/octet-stream",
      });

      await s3Client
        .send(command)
        .then(() => {
          logger.info(`✅ Uploaded original video to S3 via SDK: ${pathLower}`);
          return;
        })
        .catch((err) => {
          logger.error("❌ Upload failed via SDK:", err);
          throw new Error(
            `Failed to upload ${pathLower} via SDK: ${err.message}`
          );
          return;
        });

      return pathLower.includes("public") ? publicUrl : pathLower;
    } catch (error) {
      logger.error(`Hetzner upload error: ${error.message}`);
      throw error;
    }
  }
}

module.exports = new HetznerService();
