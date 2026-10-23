#!/usr/bin/env bash
# Runs the end-to-end specs against the real app and worker on 127.0.0.1:8787,
# with a throwaway database and media folder under /tmp/gma-e2e-*. Seeds the demo
# family (photos only without ffmpeg), adds Ben as an admin and pairs a frame.
# Leaves nothing running. KEEP=1 keeps the temp folder (logs) for a look.
#
#   bash web/e2e/run.sh [playwright args, e.g. grandma-audit.spec.js]
set -euo pipefail

WEB="$(cd "$(dirname "$0")/.." && pwd)"
SERVER="$(cd "$WEB/../server" && pwd)"
PORT=8787

if lsof -nP -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1; then
  echo "Port $PORT is already in use. Stop whatever is on it first." >&2
  exit 1
fi

TMP="$(mktemp -d /tmp/gma-e2e-XXXXXX)"
mkdir -p "$TMP/data" "$TMP/media"
APP_PID=""
WORKER_PID=""

cleanup() {
  local status=$?
  for pid in $APP_PID $WORKER_PID; do
    kill "$pid" 2>/dev/null || true
  done
  for pid in $APP_PID $WORKER_PID; do
    wait "$pid" 2>/dev/null || true
  done
  if [ "${KEEP:-0}" = "1" ] || [ "$status" -ne 0 ]; then
    echo "Logs kept in $TMP"
  else
    rm -rf "$TMP"
  fi
  exit "$status"
}
trap cleanup EXIT INT TERM

# WebAuthn refuses an IP address as the relying party, so the browser uses
# localhost while the server binds the loopback address only.
export NODE_ENV=development
export HOST=127.0.0.1
export PORT
export PUBLIC_URL="http://localhost:$PORT"
export DATA_DIR="$TMP/data"
export MEDIA_DIR="$TMP/media"
export EMAIL_TRANSPORT=console
export LOG_LEVEL=info

(cd "$SERVER" && node scripts/seed-demo.js --yes --no-video) > "$TMP/seed.log" 2>&1
(cd "$SERVER" && node scripts/create-admin.js --name "Ben" --email ben@example.com) > "$TMP/admin.log" 2>&1
FRAME_URL="$(cd "$SERVER" && node scripts/pair-device.js --name "Grandma's frame" | grep -Eo 'https?://[^ ]+/grandma\?device=[A-Za-z0-9_-]+' | head -1)"
if [ -z "$FRAME_URL" ]; then
  echo "Pairing the frame printed no link." >&2
  exit 1
fi

node "$SERVER/src/index.js" > "$TMP/app.log" 2>&1 &
APP_PID=$!
node "$SERVER/src/worker.js" > "$TMP/worker.log" 2>&1 &
WORKER_PID=$!

for _ in $(seq 1 50); do
  if curl -fsS "http://127.0.0.1:$PORT/healthz" >/dev/null 2>&1; then break; fi
  sleep 0.2
done
curl -fsS "http://127.0.0.1:$PORT/healthz" >/dev/null

export E2E_TMP="$TMP"
export E2E_BASE_URL="$PUBLIC_URL"
export E2E_APP_LOG="$TMP/app.log"
export E2E_FRAME_URL="$FRAME_URL"
export E2E_ADMIN_EMAIL=ben@example.com
export E2E_SHOTS="$WEB/e2e/shots"

cd "$WEB"
npx playwright test -c e2e/playwright.config.js "$@"
