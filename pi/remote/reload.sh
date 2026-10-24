#!/usr/bin/env bash
# Restart the kiosk (cage + Chromium) on the frame. Grandma sees a few seconds
# of black, then her screen again.
#
#   pi/remote/reload.sh <host>
#
# Gentler: /admin's "Reload" on the frame sends a reload over the live
# connection without restarting the browser.
set -euo pipefail
# shellcheck source=_common.sh
. "$(dirname "$0")/_common.sh"

usage() { sed -n '2,8p' "$0" | sed 's/^# \{0,1\}//'; }

require_host "${1-}"
gma_ssh_tty 'sudo systemctl restart gma-kiosk.service && sleep 8 && echo "gma-kiosk: $(systemctl is-active gma-kiosk.service)"'
