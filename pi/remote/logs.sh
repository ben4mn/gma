#!/usr/bin/env bash
# Show the frame's logs (kiosk, night mode, network watchdog, nightly restart).
#
#   pi/remote/logs.sh <host>              this boot, last 300 lines
#   pi/remote/logs.sh <host> -f           follow live (Ctrl-C to stop)
#   pi/remote/logs.sh <host> --previous   the boot before this one (after a crash or watchdog reboot)
#   pi/remote/logs.sh <host> --all        everything this boot, not just the gma units
set -euo pipefail
# shellcheck source=_common.sh
. "$(dirname "$0")/_common.sh"

usage() { sed -n '2,7p' "$0" | sed 's/^# \{0,1\}//'; }

require_host "${1-}"
shift

units="-u gma-kiosk.service -u gma-display.service -u gma-netwatch.service -u gma-kiosk-restart.service"
boot="-b 0"
follow=""
while [[ $# -gt 0 ]]; do
    case $1 in
        -f|--follow) follow="-f" ;;
        --previous) boot="-b -1" ;;
        --all) units="" ;;
        -h|--help) usage; exit 0 ;;
        *) die "unknown option: $1" ;;
    esac
    shift
done

gma_ssh_tty "sudo journalctl $units $boot -n 300 --no-pager $follow"
