# shellcheck shell=bash
# Shared helpers for the gma kiosk scripts. Sourced, never run.
# Installed to /usr/local/lib/gma-kiosk/common.sh by pi/install.sh.

GMA_CONFIG=${GMA_CONFIG:-/etc/default/gma-kiosk}
GMA_STATE_DIR=${GMA_STATE_DIR:-/var/lib/gma-kiosk}
GMA_KIOSK_USER=${GMA_KIOSK_USER:-kiosk}
GMA_KIOSK_UNIT=${GMA_KIOSK_UNIT:-gma-kiosk.service}

gma_log()  { printf '%s\n' "$*"; }
gma_warn() { printf 'warning: %s\n' "$*" >&2; }
gma_die()  { printf 'error: %s\n' "$*" >&2; exit 1; }

# Read one KEY from the config file without sourcing it (the file holds the
# pairing secret and is edited by hand, so it is parsed, never executed).
# Accepts KEY=value, KEY="value" and KEY='value'. Prints the default if absent.
gma_config_get() {
    local key=$1 default=${2-} line value
    if [[ ! -r $GMA_CONFIG ]]; then
        printf '%s' "$default"
        return 0
    fi
    line=$(grep -E "^[[:space:]]*${key}=" "$GMA_CONFIG" 2>/dev/null | tail -n 1) || true
    if [[ -z $line ]]; then
        printf '%s' "$default"
        return 0
    fi
    value=${line#*=}
    # Drop a trailing comment only when the value is unquoted.
    case $value in
        \"*\") value=${value#\"}; value=${value%\"} ;;
        \'*\') value=${value#\'}; value=${value%\'} ;;
        *) value=${value%%[[:space:]]#*} ;;
    esac
    printf '%s' "$value"
}

# https://gma.4mn.org/grandma?device=abc -> https://gma.4mn.org
gma_origin_of() {
    local url=$1 rest
    rest=${url#*://}
    printf '%s://%s' "${url%%://*}" "${rest%%/*}"
}

gma_kiosk_uid() { id -u "$GMA_KIOSK_USER" 2>/dev/null; }

# Prints the kiosk user's XDG_RUNTIME_DIR, or fails if the session is not up.
gma_runtime_dir() {
    local uid
    uid=$(gma_kiosk_uid) || return 1
    [[ -d /run/user/$uid ]] || return 1
    printf '/run/user/%s' "$uid"
}

# Prints the name of cage's Wayland socket (wayland-0 normally), or fails.
gma_wayland_display() {
    local rt sock
    rt=$(gma_runtime_dir) || return 1
    for sock in "$rt"/wayland-[0-9]*; do
        [[ $sock == *.lock ]] && continue
        if [[ -S $sock ]]; then
            printf '%s' "${sock##*/}"
            return 0
        fi
    done
    return 1
}

# Run a command as the kiosk user inside its Wayland session (wlr-randr, grim).
gma_as_kiosk_wayland() {
    local rt wd
    rt=$(gma_runtime_dir) || { gma_warn "the kiosk session is not running (no /run/user/<uid>)"; return 1; }
    wd=$(gma_wayland_display) || { gma_warn "no Wayland socket in $rt (is cage running?)"; return 1; }
    runuser -u "$GMA_KIOSK_USER" -- env XDG_RUNTIME_DIR="$rt" WAYLAND_DISPLAY="$wd" "$@"
}

# Seconds since the epoch, for state files.
gma_now() { date +%s; }

# HH:MM -> minutes since midnight; fails on anything else.
gma_hhmm_to_minutes() {
    local hhmm=$1 h m
    [[ $hhmm =~ ^([01][0-9]|2[0-3]):([0-5][0-9])$ ]] || return 1
    h=${BASH_REMATCH[1]}
    m=${BASH_REMATCH[2]}
    printf '%d' $((10#$h * 60 + 10#$m))
}

# Is minute-of-day $1 inside the night window [$2, $3)? Handles windows that
# cross midnight (21:00-07:00). start == end means "no night".
gma_is_night() {
    local now=$1 start=$2 end=$3
    if (( start == end )); then
        return 1
    elif (( start < end )); then
        (( now >= start && now < end ))
    else
        (( now >= start || now < end ))
    fi
}
