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
# ffmpeg/ffprobe: video and voice notes.
# libheif-examples: heif-dec, which lib/media.js looks for on PATH to decode
#   iPhone HEIC photos (sharp's bundled libvips can't decode HEVC). The HEVC
#   decoder is the libde265 plugin: libheif1 depends on it in trixie, and it is
#   named here too so --no-install-recommends can never leave HEIC undecodable.
# tini: PID 1; forwards signals so the worker can finish an ffmpeg run on stop.
# The last line fails the build if any tool the app looks for is missing.
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      ffmpeg libheif-examples libheif-plugin-libde265 tini ca-certificates \
 && rm -rf /var/lib/apt/lists/* \
 && command -v ffmpeg ffprobe heif-dec tini >/dev/null

# The root filesystem is read-only in compose: the app writes only to /data
# (the database), /media (the photo drive) and /tmp (a tmpfs). npm's cache and
# logs go to /tmp so `docker compose run --rm app npm run …` works there too.
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=8080 \
    DATA_DIR=/data \
    MEDIA_DIR=/media \
    WEB_DIR=/app/web \
    NPM_CONFIG_UPDATE_NOTIFIER=false \
    NPM_CONFIG_FUND=false \
    NPM_CONFIG_CACHE=/tmp/.npm

WORKDIR /app/server
COPY --from=deps /app/server/node_modules ./node_modules
COPY server/ ./
COPY web/ /app/web/

# A fresh named volume (gma_data) copies this ownership the first time it is
# mounted. The media volume is the drive's own folder, owned by Ben (uid 1000).
RUN mkdir -p /data /media && chown 1000:1000 /data /media
USER 1000:1000

EXPOSE 8080
# The app's check. The worker's (scripts/worker-health.js) is set in docker-compose.yml.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:' + (process.env.PORT || 8080) + '/healthz').then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "src/index.js"]
