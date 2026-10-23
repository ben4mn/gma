#!/usr/bin/env bash
# One screen of health for the frame: kiosk, display, network, power, audio.
#
#   pi/remote/status.sh <host>
set -euo pipefail
# shellcheck source=_common.sh
. "$(dirname "$0")/_common.sh"

usage() { sed -n '2,4p' "$0" | sed 's/^# \{0,1\}//'; }

require_host "${1-}"
gma_ssh_tty 'sudo /usr/local/bin/gma-status'
