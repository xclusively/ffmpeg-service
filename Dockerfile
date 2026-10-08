# Use Node.js 20
FROM node:20-bookworm-slim

WORKDIR /app

# ffmpeg/ffprobe run inside this image (no Docker CLI, no host Docker socket).
RUN apt-get update && \
    apt-get install -y --no-install-recommends ffmpeg && \
    rm -rf /var/lib/apt/lists/*

# Copy package files
COPY package*.json ./
RUN npm install

# Copy source code
COPY infisical-loader.js ./
COPY index.js ./
COPY src/ ./src/

EXPOSE 8567

CMD ["node", "index.js"]