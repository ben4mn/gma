# shellcheck shell=bash
# Shared by pi/remote/*.sh. These run on Ben's own machine (macOS's bash 3.2
# is fine) and reach the frame over Tailscale SSH. Sourced, never run.
#
# HOST is the frame's Tailscale name (e.g. gma-frame) or user@host.
# The default SSH user is kiosk-admin; override with GMA_SSH_USER=...

GMA_SSH_USER=${GMA_SSH_USER:-kiosk-admin}
SSH_OPTS=(-o ConnectTimeout=15 -o ServerAliveInterval=15 -o ServerAliveCountMax=4)
TARGET=""

die() { printf 'error: %s\n' "$*" >&2; exit 1; }

# Sets TARGET from the first argument, or prints usage and exits.
require_host() {
    if [[ $# -lt 1 || -z $1 || $1 == -* ]]; then
        usage >&2
        exit 2
    fi
    case $1 in
        *@*) TARGET=$1 ;;
        *) TARGET=$GMA_SSH_USER@$1 ;;
    esac
}

# Plain SSH (for output we capture) and SSH with a terminal (for sudo prompts,
# live output and Ctrl-C).
gma_ssh() { ssh "${SSH_OPTS[@]}" "$TARGET" "$@"; }
gma_ssh_tty() { ssh -t "${SSH_OPTS[@]}" "$TARGET" "$@"; }
