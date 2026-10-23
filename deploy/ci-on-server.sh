#!/usr/bin/env bash
# CI for gma.4mn.org on Ben's Debian homelab, run from a Mac checkout:
#
#   bash deploy/ci-on-server.sh            rsync, build gma:ci, server tests, media smoke test, clean up
#   bash deploy/ci-on-server.sh --dry-run  print the plan and every remote command, touch nothing
#
# What it does, in order:
#   1. rsyncs the repo (no node_modules, .git, data, media) to /home/ben/gma-ci/repo
#   2. docker build -t gma:ci (the production Dockerfile, unchanged)
#   3. the server test suite inside gma:ci, with ffmpeg, ffprobe and heif-dec
#      present; any skipped test fails the run, because in the image nothing
#      has a reason to skip
#   4. makes the media fixtures (deploy/ci/make-fixtures.sh) and runs the real
#      worker on them (deploy/ci/smoke.mjs) at the worker's CPU limit, checking
#      every rendition with ffprobe and timing the 4K HDR transcode
#   5. removes every container, network and volume it made, and the previous
#      gma:ci image if the build left it untagged; copies the logs back here
#
# The server is shared with ~40 other stacks, so the limits are fixed here
# rather than taken from the environment: work only under /home/ben/gma-ci,
# containers named gma-ci-*, one network gma-ci_net on 10.36.0.0/24 (Docker's
# default address pools are used up there), volumes prefixed gma-ci_, no
# published ports, no bind mounts outside /home/ben/gma-ci, no sudo. Nothing
# here touches /home/ben/gma, /mnt/seagate or another project's containers.
#
# Environment (optional):
#   GMA_CI_HOST     ssh destination (default ben@192.168.68.69)
#   GMA_CI_CPUS     CPU limit for the smoke test (default: the worker's cpus: in docker-compose.yml)
#   GMA_CI_RETRIES  build attempts, a minute apart, re-syncing each time (default 3)
#   GMA_CI_RESULTS  where the logs land on this Mac (default a new dir under $TMPDIR)
#
# Exit codes: 0 everything passed, 1 a test or check failed, 2 usage or setup.

# The whole script is one { … } block, so bash reads all of it before running
# any of it: an edit to this file during a run (a git pull, another agent)
# can't change what the run does halfway through.
{
set -euo pipefail

usage() { sed -n '2,8p' "$0" | sed 's/^# \{0,1\}//'; }

DRY_RUN=0
SKIP_TESTS=0
SKIP_SMOKE=0
for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=1 ;;
    --skip-tests) SKIP_TESTS=1 ;;
    --skip-smoke) SKIP_SMOKE=1 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Unknown option: $arg" >&2; usage >&2; exit 2 ;;
  esac
done

REPO=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
HOST=${GMA_CI_HOST:-ben@192.168.68.69}
REMOTE=/home/ben/gma-ci
IMAGE=gma:ci
NETWORK=gma-ci_net
SUBNET=10.36.0.0/24
CONTAINER_PREFIX=gma-ci
RETRIES=${GMA_CI_RETRIES:-3}
SMOKE_PHOTO=design/assets/photos/p1003.jpg
STAMP=$(date +%Y%m%d-%H%M%S)
RESULTS=${GMA_CI_RESULTS:-${TMPDIR:-/tmp}/gma-ci-$STAMP}

# The smoke test runs at the worker's real CPU limit, read from docker-compose.yml.
compose_cpus() {
  awk '/^  worker:/{w=1; next} /^  [a-z]/{w=0} w && /^ *cpus:/{gsub(/[^0-9.]/, "", $2); print $2; exit}' "$REPO/docker-compose.yml"
}
CPUS=${GMA_CI_CPUS:-$(compose_cpus)}
CPUS=${CPUS:-3}

[[ "$RETRIES" =~ ^[1-9][0-9]*$ ]] || { echo "GMA_CI_RETRIES must be a positive whole number" >&2; exit 2; }
[[ "$CPUS" =~ ^[0-9]+(\.[0-9]+)?$ ]] || { echo "GMA_CI_CPUS must be a number (got $CPUS)" >&2; exit 2; }
[[ -f "$REPO/Dockerfile" && -f "$REPO/server/package.json" ]] || { echo "Run this from a gma checkout ($REPO has no Dockerfile)" >&2; exit 2; }
[[ -f "$REPO/$SMOKE_PHOTO" ]] || { echo "Missing $SMOKE_PHOTO for the HEIC fixture" >&2; exit 2; }

say() { printf '\n==> %s\n' "$*"; }
note() { printf '    %s\n' "$*"; }

# One remote command. Everything runs through bash -lc on the server with
# set -euo pipefail. --dry-run prints it instead.
remote() {
  if (( DRY_RUN )); then
    printf '    [ssh %s] %s\n' "$HOST" "$1"
    return 0
  fi
  ssh -o BatchMode=yes -o ConnectTimeout=10 "$HOST" "set -euo pipefail; $1"
}

# The docker run options every CI container shares: no published ports, no
# capabilities, the production image's user and read-only root.
HARDENED="--rm --cap-drop ALL --security-opt no-new-privileges --read-only --user 1000:1000"

# --- clean up (also on Ctrl-C or a failure) ----------------------------------

OLD_IMAGE_ID=""
cleanup() {
  local status=$?
  trap - EXIT INT TERM
  if (( ! DRY_RUN )); then
    say "Cleaning up on $HOST"
    remote "
      for c in \$(docker ps -aq --filter name='^${CONTAINER_PREFIX}-'); do docker rm -f \"\$c\" >/dev/null; done
      if docker network inspect $NETWORK >/dev/null 2>&1; then docker network rm $NETWORK >/dev/null; fi
      for v in \$(docker volume ls -q --filter name='^${CONTAINER_PREFIX}_'); do docker volume rm \"\$v\" >/dev/null; done
      old='$OLD_IMAGE_ID'; new=\$(docker image inspect -f '{{.Id}}' $IMAGE 2>/dev/null || true)
      if [ -n \"\$old\" ] && [ \"\$old\" != \"\$new\" ] && [ -z \"\$(docker image inspect -f '{{join .RepoTags \",\"}}' \"\$old\" 2>/dev/null)\" ]; then
        docker rmi \"\$old\" >/dev/null 2>&1 && echo '    removed the previous, now untagged gma:ci image' || true
      fi
      rm -rf $REMOTE/work/fixtures $REMOTE/work/smoke
      echo '    no gma-ci containers, network or volumes left'
    " || note "Cleanup could not finish; check with: ssh $HOST docker ps -a --filter name=$CONTAINER_PREFIX"
    mkdir -p "$RESULTS"
    rsync -a -e 'ssh -o BatchMode=yes' "$HOST:$REMOTE/work/results/" "$RESULTS/" 2>/dev/null || true
    note "Logs: $RESULTS"
  fi
  exit "$status"
}
trap cleanup EXIT
trap 'exit 130' INT TERM

# --- 0. preflight -------------------------------------------------------------

say "gma CI on $HOST (image $IMAGE, smoke test at $CPUS CPUs)"
(( DRY_RUN )) && note "dry run: nothing is copied, built or started"
if (( ! DRY_RUN )); then
  ssh -o BatchMode=yes -o ConnectTimeout=10 "$HOST" true 2>/dev/null \
    || { echo "Can't reach $HOST over ssh without a password" >&2; exit 2; }
fi
remote "command -v docker rsync >/dev/null; mkdir -p $REMOTE/repo $REMOTE/work/results; rm -f $REMOTE/work/results/*"
# Our network must not exist yet (a stale one from a killed run is removed),
# and nothing else may already use our subnet.
remote "
  if docker network inspect $NETWORK >/dev/null 2>&1; then
    docker network rm $NETWORK >/dev/null
  fi
  for n in \$(docker network ls -q); do
    if docker network inspect -f '{{range .IPAM.Config}}{{.Subnet}} {{end}}' \"\$n\" | grep -qw '$SUBNET'; then
      echo 'Another network already uses $SUBNET:' \$(docker network inspect -f '{{.Name}}' \"\$n\") >&2; exit 2
    fi
  done"

# --- 1+2. sync and build --------------------------------------------------------

sync_repo() {
  local cmd=(rsync -a --delete --exclude node_modules --exclude .git --exclude /data --exclude /media
    --exclude .DS_Store --exclude 'web/e2e/shots' --exclude 'test-results' --exclude 'playwright-report'
    -e 'ssh -o BatchMode=yes' "$REPO/" "$HOST:$REMOTE/repo/")
  if (( DRY_RUN )); then printf '    [local] %s\n' "${cmd[*]}"; return 0; fi
  "${cmd[@]}"
}

OLD_IMAGE_ID=$( (( DRY_RUN )) && echo "" || ssh -o BatchMode=yes "$HOST" "docker image inspect -f '{{.Id}}' $IMAGE 2>/dev/null || true")

attempt=1
while :; do
  say "Sync and build (attempt $attempt of $RETRIES)"
  sync_repo
  build_start=$(date +%s)
  if remote "cd $REMOTE/repo && DOCKER_BUILDKIT=1 docker build --pull -t $IMAGE . 2>&1 | tail -n 25"; then
    (( DRY_RUN )) || note "built $IMAGE in $(( $(date +%s) - build_start )) s"
    break
  fi
  if (( attempt >= RETRIES )); then echo "The image didn't build after $RETRIES attempts." >&2; exit 1; fi
  note "build failed; another agent may be mid-edit, so trying again in 60 s"
  sleep 60
  attempt=$(( attempt + 1 ))
done
remote "docker run --rm --network none $IMAGE sh -c 'ffmpeg -version | head -1; ffprobe -version | head -1; heif-dec --version 2>&1 | head -1; node --version'" | sed 's/^/    /'

FAILED=()

# --- 3. the server test suite inside the image --------------------------------
#
# deploy.test.js checks docker-compose.yml, the Dockerfile, .env.example and the
# tunnel config, which the image doesn't contain (.dockerignore); they're
# mounted read-only where the test looks for them (the repo root is /app).

if (( ! SKIP_TESTS )); then
  say "Server tests inside $IMAGE"
  REPO_FILES="-v $REMOTE/repo/docker-compose.yml:/app/docker-compose.yml:ro \
    -v $REMOTE/repo/Dockerfile:/app/Dockerfile:ro \
    -v $REMOTE/repo/.env.example:/app/.env.example:ro \
    -v $REMOTE/repo/deploy:/app/deploy:ro"
  if remote "status=0
    docker run $HARDENED --name ${CONTAINER_PREFIX}-tests --network none \
      --tmpfs /tmp:size=1g,mode=1777 -e NODE_ENV=test \
      $REPO_FILES -v $REMOTE/work/results:/results \
      $IMAGE node --test --test-reporter=spec --test-reporter-destination=stdout \
        --test-reporter=tap --test-reporter-destination=/results/server-tests.tap 'test/**/*.test.js' \
      > $REMOTE/work/results/server-tests.log 2>&1 || status=\$?
    tail -n 12 $REMOTE/work/results/server-tests.log; exit \$status"; then
    (( DRY_RUN )) || note "the suite passed"
  else
    note "the suite FAILED (full log: server-tests.log)"
    remote "grep -nE '^\s*not ok ' $REMOTE/work/results/server-tests.tap | head -40" | sed 's/^/    /' || true
    FAILED+=("server tests")
  fi
  # In the image every tool is present: a skip means a test isn't running.
  if (( ! DRY_RUN )); then
    skips=$(ssh -o BatchMode=yes "$HOST" "grep -E '# (SKIP|TODO)' $REMOTE/work/results/server-tests.tap || true")
    if [[ -n "$skips" ]]; then
      note "these tests SKIPPED inside the image, where they must run:"
      printf '%s\n' "$skips" | sed 's/^ */      /'
      FAILED+=("skipped tests")
    else
      note "no test skipped (ffmpeg, ffprobe and heif-dec cases all ran)"
    fi
  fi
fi

# --- 4. the media smoke test ----------------------------------------------------

if (( ! SKIP_SMOKE )); then
  say "Media fixtures (throwaway root container on $NETWORK, $SUBNET)"
  remote "docker network create --driver bridge --subnet $SUBNET --label gma-ci=1 $NETWORK >/dev/null
    mkdir -p $REMOTE/work/fixtures
    docker run --rm --name ${CONTAINER_PREFIX}-fixtures --network $NETWORK --user 0:0 \
      -v $REMOTE/work/fixtures:/fixtures -v $REMOTE/repo/deploy/ci:/ci:ro \
      -v $REMOTE/repo/$SMOKE_PHOTO:/in/photo.jpg:ro \
      $IMAGE bash /ci/make-fixtures.sh /in/photo.jpg /fixtures 2>&1 | tee $REMOTE/work/results/fixtures.log
    docker network rm $NETWORK >/dev/null
    cp $REMOTE/work/fixtures/tiny.heic $REMOTE/work/results/"

  say "Media smoke test: the real worker at --cpus $CPUS"
  if remote "status=0
    docker run $HARDENED --name ${CONTAINER_PREFIX}-smoke --network none --cpus $CPUS \
      --tmpfs /tmp:size=1g,mode=1777 \
      -v $REMOTE/work:/work -v $REMOTE/repo/deploy/ci:/ci:ro \
      $IMAGE node /ci/smoke.mjs --fixtures /work/fixtures --out /work/smoke 2>&1 \
      | tee $REMOTE/work/results/smoke.log || status=\$?
    cp $REMOTE/work/smoke/timings.json $REMOTE/work/results/ 2>/dev/null || true
    exit \$status"; then
    (( DRY_RUN )) || note "the smoke test passed"
  else
    FAILED+=("media smoke test")
  fi
fi

# --- result -------------------------------------------------------------------

if (( DRY_RUN )); then say "Dry run finished"; exit 0; fi
if (( ${#FAILED[@]} )); then
  say "FAILED: ${FAILED[*]}"
  exit 1
fi
say "PASSED: image built, server tests, media smoke test"
exit 0
}
