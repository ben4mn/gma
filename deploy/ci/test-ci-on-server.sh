#!/usr/bin/env bash
# Checks deploy/ci-on-server.sh keeps to the shared server's limits, from its
# --dry-run plan (nothing is copied or started, no ssh):
#
#   bash deploy/ci/test-ci-on-server.sh
#
# Every docker run is --rm with no published ports; bind mounts come only from
# /home/ben/gma-ci; containers are gma-ci-*; the one network is gma-ci_net on
# 10.36.0.0/24; no sudo, no compose project but gma-ci, nothing under
# /home/ben/gma/ or /mnt/seagate; the tests and the smoke test have no network.
set -euo pipefail

HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
SCRIPT="$HERE/../ci-on-server.sh"
PLAN=$(GMA_CI_HOST=ci-test.invalid bash "$SCRIPT" --dry-run 2>&1)
FAILS=0

fail() { echo "FAIL: $*"; FAILS=$((FAILS + 1)); }
ok() { echo "ok   $*"; }

# Join each command's continuation lines, so one docker run is one line.
RUNS=$(printf '%s\n' "$PLAN" | tr '\n' ' ' | grep -oE 'docker run [^|;>]*' || true)
[[ -n "$RUNS" ]] || fail "the plan has no docker run at all"

count=$(printf '%s\n' "$RUNS" | grep -c . || true)
(( count >= 4 )) && ok "plans $count docker runs" || fail "expected at least 4 docker runs, saw $count"

while IFS= read -r run; do
  [[ -z "$run" ]] && continue
  short=$(printf '%s' "$run" | cut -c1-90)
  [[ "$run" == *"--rm"* ]] || fail "not --rm: $short"
  if printf '%s' "$run" | grep -qE '(^| )(-p|--publish|-P|--publish-all)( |=)'; then fail "publishes a port: $short"; fi
  if printf '%s' "$run" | grep -qE -- '--privileged|--pid[= ]host|--network[= ]host|--net[= ]host'; then fail "host access: $short"; fi
  for mount in $(printf '%s' "$run" | grep -oE -- '-v [^ ]+' | awk '{print $2}'); do
    src=${mount%%:*}
    [[ "$src" == /home/ben/gma-ci/* ]] || fail "bind mount from outside /home/ben/gma-ci: $src"
  done
  name=$(printf '%s' "$run" | grep -oE -- '--name [^ ]+' | awk '{print $2}' || true)
  [[ -z "$name" || "$name" == gma-ci-* ]] || fail "container not named gma-ci-*: $name"
done <<< "$RUNS"
ok "every docker run: --rm, no ports, no host network, mounts only from /home/ben/gma-ci, gma-ci-* names"

for name in tests smoke; do
  line=$(printf '%s\n' "$RUNS" | grep -- "--name gma-ci-$name" || true)
  [[ -n "$line" ]] || { fail "no gma-ci-$name container"; continue; }
  [[ "$line" == *"--network none"* ]] && ok "gma-ci-$name has no network" || fail "gma-ci-$name has a network"
  [[ "$line" == *"--read-only"* && "$line" == *"--cap-drop ALL"* && "$line" == *"--user 1000:1000"* ]] \
    && ok "gma-ci-$name runs like production (read-only, no capabilities, uid 1000)" \
    || fail "gma-ci-$name is not hardened like production"
done
smoke=$(printf '%s\n' "$RUNS" | grep -- '--name gma-ci-smoke' || true)
[[ "$smoke" == *"--cpus 3"* ]] && ok "the smoke test runs at the worker's cpus: 3" || fail "the smoke test isn't at the worker's CPU limit"

nets=$(printf '%s\n' "$PLAN" | grep -oE 'docker network create [^>]*' || true)
[[ "$nets" == *"--subnet 10.36.0.0/24"* && "$nets" == *" gma-ci_net"* ]] && ok "one network, gma-ci_net on 10.36.0.0/24" || fail "network create: $nets"
[[ $(printf '%s\n' "$nets" | grep -c 'docker network create') == 1 ]] || fail "more than one network is created"

if printf '%s\n' "$PLAN" | grep -qE '(^|[^a-z])sudo '; then fail "uses sudo"; else ok "no sudo"; fi
if printf '%s\n' "$PLAN" | grep -qE '/home/ben/gma(/|[^-]|$)|/mnt/seagate'; then fail "touches /home/ben/gma or /mnt/seagate"; else ok "never /home/ben/gma or /mnt/seagate"; fi
if printf '%s\n' "$PLAN" | grep -qE 'docker (system|image|volume|network|container|builder) prune|docker compose (-p [^g]|--project-name [^g])'; then
  fail "prunes or runs another compose project"
else
  ok "no prune, no other compose project"
fi
builds=$(printf '%s\n' "$PLAN" | grep -oE 'docker build [^|]*' || true)
[[ "$builds" == *"-t gma:ci "* ]] && ok "builds only gma:ci" || fail "build: $builds"
grep -q 'docker rm -f' "$SCRIPT" && grep -q "name='^\${CONTAINER_PREFIX}-'" "$SCRIPT" \
  && ok "cleanup removes only gma-ci-* containers" || fail "cleanup filter changed"

# bash reads a script as it runs it; the body must be one { … } block so an
# edit during a run (a git pull, another agent) can't change the run halfway.
[[ $(grep -c '^{$' "$SCRIPT") == 1 && $(tail -n 1 "$SCRIPT") == '}' ]] \
  && ok "the script body is one block, read whole before it runs" || fail "the script body isn't wrapped in { … }"

# Usage errors exit 2 before anything runs.
set +e
GMA_CI_CPUS=lots bash "$SCRIPT" --dry-run >/dev/null 2>&1; [[ $? == 2 ]] && ok "a bad GMA_CI_CPUS exits 2" || fail "a bad GMA_CI_CPUS didn't exit 2"
bash "$SCRIPT" --nope >/dev/null 2>&1; [[ $? == 2 ]] && ok "an unknown option exits 2" || fail "an unknown option didn't exit 2"
set -e

(( FAILS == 0 )) && echo "all checks passed" || { echo "$FAILS check(s) failed"; exit 1; }
