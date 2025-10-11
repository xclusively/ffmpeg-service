# Use Node.js 20
FROM node:20-bookworm-slim

WORKDIR /app

# Install Docker CLI (minimal)
RUN apt-get update && \
    apt-get install -y docker.io && \
    rm -rf /var/lib/apt/lists/*

# Copy package files
COPY package*.json ./
RUN npm install --production

# Copy source code
COPY index.js ./
COPY src/ ./src/

EXPOSE 8567

CMD ["node", "index.js"]