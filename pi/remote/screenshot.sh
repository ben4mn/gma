#!/usr/bin/env bash
# Take a screenshot of what Grandma sees and copy it here.
#
#   pi/remote/screenshot.sh <host> [out.png]
#
# An HDMI panel switched off for the night (DISPLAY_OFF_AT_NIGHT=1) has nothing
# to capture until NIGHT_END.
set -euo pipefail
# shellcheck source=_common.sh
. "$(dirname "$0")/_common.sh"

usage() { sed -n '2,7p' "$0" | sed 's/^# \{0,1\}//'; }

require_host "${1-}"
shift
out=${1:-gma-screenshot-$(date +%Y%m%d-%H%M%S).png}
remote=/tmp/gma-screenshot-$$-$RANDOM.png

gma_ssh_tty "sudo /usr/local/bin/gma-screenshot $remote"
scp -q "${SSH_OPTS[@]}" "$TARGET:$remote" "$out"
gma_ssh "rm -f $remote" || true
echo "saved $out"
if [[ $(uname) == Darwin ]]; then
    echo "open it with: open '$out'"
fi
