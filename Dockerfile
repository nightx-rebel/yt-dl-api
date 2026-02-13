# Use an LTS Node image
FROM node:20-slim

# install system deps: ffmpeg, aria2, curl, ca-certificates, python (some yt-dlp features)
RUN apt-get update && \
    apt-get install -y --no-install-recommends \
      ffmpeg \
      aria2 \
      ca-certificates \
      curl \
      python3 \
      && rm -rf /var/lib/apt/lists/*

# Install yt-dlp binary (official)
RUN curl -L https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp -o /usr/local/bin/yt-dlp && \
    chmod +x /usr/local/bin/yt-dlp

WORKDIR /app

# Copy package.json and install production deps
COPY package*.json ./
RUN npm install 

# Copy app
COPY . .

ENV NODE_ENV=production
ENV PORT=3000

EXPOSE 3000

CMD ["node", "index.js"]
