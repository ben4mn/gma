# syntax=docker/dockerfile:1
# The one image for gma.4mn.org. docker compose runs it twice: the app
# (node src/index.js) and the worker (node src/worker.js). Build context: the repo root.

# Native modules (better-sqlite3) normally come prebuilt; the toolchain is only
# here for the day a prebuilt binary is missing, and never reaches the final image.
FROM node:24-trixie-slim AS deps
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ ca-certificates \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /app/server
COPY server/package.json server/package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

FROM node:24-trixie-slim
# ffmpeg/ffprobe: video and voice. heif-dec (libheif-examples): iPhone HEIC photos.
# libvips-tools: the vips CLI for poking at images by hand. tini: PID 1, forwards signals.
RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg libvips-tools libheif-examples tini ca-certificates \
 && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=8080 \
    DATA_DIR=/data \
    MEDIA_DIR=/media \
    WEB_DIR=/app/web \
    NPM_CONFIG_UPDATE_NOTIFIER=false

WORKDIR /app/server
COPY --from=deps /app/server/node_modules ./node_modules
COPY server/ ./
COPY web/ /app/web/

# Named volumes copy this ownership the first time they are mounted.
RUN mkdir -p /data /media && chown node:node /data /media
USER node

EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:' + (process.env.PORT || 8080) + '/healthz').then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "src/index.js"]
