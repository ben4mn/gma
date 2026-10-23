#!/usr/bin/env bash
# Push this repo's pi/ kit to the frame and run install.sh there. The repo is
# private, so the Pi never pulls from GitHub: Ben's machine pushes.
#
#   pi/remote/push-update.sh <host> [install.sh options...]
#
#   pi/remote/push-update.sh gma-frame
#   pi/remote/push-update.sh gma-frame --night 21:30-07:00
#
# The first install needs the pairing URL. Best: run push-update.sh with no URL
# and let install.sh prompt for it with hidden input. --url also works: it is
# sent over SSH's input into a 0600 file that install.sh reads and deletes, so
# it never appears in a command line on the Pi (sudo logs those to the
# journal), but it does sit in your own shell history: clear it.
set -euo pipefail
# shellcheck source=_common.sh
. "$(dirname "$0")/_common.sh"

usage() { sed -n '2,14p' "$0" | sed 's/^# \{0,1\}//'; }

require_host "${1-}"
shift

KIT=$(cd "$(dirname "$0")/.." && pwd)
REMOTE_DIR=gma-kit   # in the SSH user's home on the Pi
[[ -f $KIT/install.sh && -d $KIT/files ]] || die "the kit is not at $KIT"

# The pairing token must never end up in the repo; refuse to ship one.
if grep -rIlE 'device=[A-Za-z0-9_-]{32,}' "$KIT" >/dev/null 2>&1; then
    die "a pairing token is written in the kit: $(grep -rIlE 'device=[A-Za-z0-9_-]{32,}' "$KIT" | tr '\n' ' ')"
fi

echo "==> Copying the kit to $TARGET:~/$REMOTE_DIR"
if command -v rsync >/dev/null 2>&1 && gma_ssh 'command -v rsync' >/dev/null 2>&1; then
    rsync -rlptz --delete --exclude '.DS_Store' --exclude '._*' \
        -e "ssh ${SSH_OPTS[*]}" "$KIT/" "$TARGET:$REMOTE_DIR/"
else
    # First push to a fresh image may have no rsync yet: tar over SSH instead.
    # COPYFILE_DISABLE and --no-xattrs keep macOS metadata out of the archive.
    COPYFILE_DISABLE=1 tar -czf - --no-xattrs --exclude '.DS_Store' --exclude '._*' -C "$KIT" . |
        gma_ssh "rm -rf $REMOTE_DIR.new && mkdir -p $REMOTE_DIR.new && tar -xzf - -C $REMOTE_DIR.new && rm -rf $REMOTE_DIR && mv $REMOTE_DIR.new $REMOTE_DIR"
fi

# Take --url out of the arguments: it must not reach the remote command line.
url=""
rest=()
while [[ $# -gt 0 ]]; do
    case $1 in
        --url) [[ $# -ge 2 && -n $2 ]] || die "--url needs a value"; url=$2; shift ;;
        --url=*) url=${1#*=} ;;
        --url-file|--url-file=*) die "--url-file is install.sh's own option on the Pi; pass --url here" ;;
        *) rest+=("$1") ;;
    esac
    shift
done

URL_FILE=$REMOTE_DIR/.pairing-url   # relative to the SSH user's home, like the kit
url_args=""
if [[ -n $url ]]; then
    printf '%s\n' "$url" | gma_ssh "umask 077 && cat >$URL_FILE"
    url_args="--url-file $URL_FILE"
fi

args=""
if [[ ${#rest[@]} -gt 0 ]]; then
    args=$(printf '%q ' "${rest[@]}")
fi
echo "==> Running install.sh on $TARGET"
status=0
gma_ssh_tty "sudo bash $REMOTE_DIR/install.sh $url_args $args" || status=$?
# install.sh deletes the file once read; this covers a run that died first.
if [[ -n $url ]]; then
    gma_ssh "rm -f $URL_FILE" || echo "warning: could not remove ~/$URL_FILE on the frame; delete it by hand" >&2
fi
exit "$status"
