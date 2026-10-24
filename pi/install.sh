#!/bin/bash
# Sets up Grandma's frame: Raspberry Pi OS Lite 64-bit (Debian 13 trixie) on a
# Pi 4, Chromium in kiosk mode under cage, night mode, a network watchdog and
# Ben's maintenance tools. Run as root ON THE PI. Safe to re-run: it only
# changes what differs, keeps hand edits in /etc/default/gma-kiosk, and never
# upgrades Chromium (that is gma-update's job).
#
#   sudo ./install.sh                     # asks for the pairing URL (hidden input)
#   sudo ./install.sh --url-file FILE     # reads it from FILE, then deletes FILE
#   sudo ./install.sh                     # re-run: keeps the stored URL and settings
#
# Prefer the prompt or --url-file: sudo logs its whole command line to the
# journal (persistent on the frame), so --url URL leaves the token on disk.
#
# Options:
#   --url-file FILE        read the pairing URL from the first line of FILE, then delete FILE
#                          (pi/remote/push-update.sh --url uses this)
#   --url URL              the pairing URL from /admin (prompted for if absent and not stored)
#   --hostname NAME        e.g. gma-frame
#   --night HH:MM-HH:MM    night window, default 21:00-07:00 (keep it the same as /admin)
#   --timezone TZ          default America/Chicago
#   --night-brightness N   DSI panel brightness at night, percent (1-100), default 10
#   --display-off-at-night / --no-display-off-at-night
#                          HDMI panel only: switch the output off at night
#   --dsi-overlay OVERLAY  add dtoverlay=OVERLAY to config.txt, e.g.
#                          vc4-kms-dsi-waveshare-panel,10_1_inch ("none" removes it)
#   --hdmi-force-hotplug   add vc4.force_hotplug=1 (HDMI panel powered separately)
#   --skip-apt             do not install packages (offline re-run)
#   --no-restart           do not restart the kiosk at the end
set -euo pipefail

KIT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
FILES=$KIT_DIR/files
CONFIG=/etc/default/gma-kiosk
KIOSK_USER=kiosk
EXPECTED_HOST=gma.4mn.org
BOOT_DIR=/boot/firmware
[[ -d $BOOT_DIR ]] || BOOT_DIR=/boot

# The verified package set (docs/research/phase1-research.json, pi-kiosk).
PACKAGES=(chromium cage seatd pipewire pipewire-pulse wireplumber fonts-noto-color-emoji
          grim wlr-randr brightnessctl curl jq)
# --no-install-recommends (which keeps rpi-chromium-mods out) also drops these:
# dbus-user-session gives the kiosk user the session bus PipeWire/WirePlumber
# need; libpam-systemd provides pam_systemd for the kiosk's logind session;
# alsa-utils has arecord/aplay for the mic test; rsync lets push-update.sh sync.
EXTRA_PACKAGES=(dbus-user-session libpam-systemd alsa-utils rsync)
# Chromium's setuid sandbox helper, if this archive builds it (otherwise
# Chromium uses user namespaces).
OPTIONAL_PACKAGES=(chromium-sandbox)

# --- output ------------------------------------------------------------------
step() { printf '\n==> %s\n' "$*"; }
log()  { printf '    %s\n' "$*"; }
warn() { printf '    WARNING: %s\n' "$*" >&2; }
die()  { printf '\nERROR: %s\n' "$*" >&2; exit 1; }

usage() { sed -n '2,/^set -euo/p' "$0" | sed '$d' | sed 's/^# \{0,1\}//'; }

# --- arguments ---------------------------------------------------------------
ARG_URL=""
ARG_URL_FILE=""
ARG_HOSTNAME=""
ARG_NIGHT=""
ARG_TIMEZONE=""
ARG_NIGHT_PCT=""
ARG_OFF_AT_NIGHT=""
ARG_DSI_OVERLAY=""
ARG_FORCE_HOTPLUG=0
SKIP_APT=0
NO_RESTART=0

need_value() { [[ $# -ge 2 && -n $2 ]] || die "$1 needs a value (see --help)"; }

while (( $# )); do
    case $1 in
        --url) need_value "$@"; ARG_URL=$2; shift ;;
        --url=*) ARG_URL=${1#*=} ;;
        --url-file) need_value "$@"; ARG_URL_FILE=$2; shift ;;
        --url-file=*) ARG_URL_FILE=${1#*=} ;;
        --hostname) need_value "$@"; ARG_HOSTNAME=$2; shift ;;
        --night) need_value "$@"; ARG_NIGHT=$2; shift ;;
        --timezone) need_value "$@"; ARG_TIMEZONE=$2; shift ;;
        --night-brightness) need_value "$@"; ARG_NIGHT_PCT=$2; shift ;;
        --display-off-at-night) ARG_OFF_AT_NIGHT=1 ;;
        --no-display-off-at-night) ARG_OFF_AT_NIGHT=0 ;;
        --dsi-overlay) need_value "$@"; ARG_DSI_OVERLAY=$2; shift ;;
        --hdmi-force-hotplug) ARG_FORCE_HOTPLUG=1 ;;
        --skip-apt) SKIP_APT=1 ;;
        --no-restart) NO_RESTART=1 ;;
        -h|--help) usage; exit 0 ;;
        *) die "unknown option: $1 (see --help)" ;;
    esac
    shift
done

# --- state tracked across steps ---------------------------------------------
DIRTY_KIOSK=0      # restart the kiosk at the end
DIRTY_DISPLAY=0
DIRTY_UNITS=0
DIRTY_JOURNALD=0
DIRTY_NM=0
DIRTY_AUDIO=0      # restart the kiosk user's WirePlumber (it outlives kiosk restarts: linger)
REBOOT_NEEDED=0

mark_dirty() {
    case ${1-} in
        kiosk) DIRTY_KIOSK=1 ;;
        audio) DIRTY_AUDIO=1 ;;
        display) DIRTY_DISPLAY=1 ;;
        units) DIRTY_UNITS=1 ;;
        journald) DIRTY_JOURNALD=1 ;;
        nm) DIRTY_NM=1 ;;
        both) DIRTY_KIOSK=1; DIRTY_DISPLAY=1 ;;
    esac
}

# install_file SRC DEST MODE OWNER:GROUP [dirty-tags, space-separated]
install_file() {
    local src=$1 dest=$2 mode=$3 owner=$4 tag=${5-}
    [[ -f $src ]] || die "missing kit file: $src"
    if [[ -f $dest ]] && cmp -s "$src" "$dest"; then
        chown "$owner" "$dest"
        chmod "$mode" "$dest"
        return 0
    fi
    install -D -m "$mode" -o "${owner%%:*}" -g "${owner##*:}" "$src" "$dest"
    log "installed $dest"
    local t
    for t in $tag; do mark_dirty "$t"; done
}

# --- config file (parsed, never sourced: it holds the pairing secret) -------
config_get() { # KEY [default]
    local key=$1 default=${2-} line value
    if [[ ! -r $CONFIG ]]; then printf '%s' "$default"; return 0; fi
    line=$(grep -E "^[[:space:]]*${key}=" "$CONFIG" | tail -n 1) || true
    if [[ -z $line ]]; then printf '%s' "$default"; return 0; fi
    value=${line#*=}
    case $value in
        \"*\") value=${value#\"}; value=${value%\"} ;;
        \'*\') value=${value#\'}; value=${value%\'} ;;
    esac
    printf '%s' "$value"
}

KNOWN_KEYS="KIOSK_URL TIMEZONE NIGHT_START NIGHT_END NIGHT_BRIGHTNESS_PERCENT DAY_BRIGHTNESS_PERCENT DISPLAY_OFF_AT_NIGHT DISPLAY_OUTPUT HEALTH_URL OFFLINE_URL"

mask_url() {
    local url=$1 token
    token=${url##*device=}
    printf '%s?device=%s... (%d chars)' "${url%%\?*}" "${token:0:4}" "${#token}"
}

origin_of() {
    local url=$1 rest
    rest=${url#*://}
    printf '%s://%s' "${url%%://*}" "${rest%%/*}"
}

# --- steps -------------------------------------------------------------------
preflight() {
    step "Checking the system"
    [[ $(id -u) == 0 ]] || die "run as root: sudo $0 ..."
    [[ -d $FILES ]] || die "kit files not found at $FILES (run install.sh from the pi/ folder)"
    local codename arch
    codename=$(. /etc/os-release && echo "${VERSION_CODENAME:-unknown}")
    arch=$(dpkg --print-architecture)
    [[ $codename == trixie ]] || warn "this kit targets Debian 13 trixie; this is '$codename'"
    [[ $arch == arm64 ]] || warn "this kit targets 64-bit Raspberry Pi OS (arm64); this is '$arch'"
    log "Raspberry Pi OS ($codename, $arch), model: $(tr -d '\0' </proc/device-tree/model 2>/dev/null || echo unknown)"
    if grep -qw 'overlayroot=tmpfs' "$BOOT_DIR/cmdline.txt" 2>/dev/null; then
        warn "the overlay filesystem is ON: every reboot will wipe the saved photos, the pairing cookie,"
        warn "Tailscale's identity and the clock file. Turn it off in raspi-config (Performance > Overlay)."
    fi
}

resolve_settings() {
    step "Settings"
    if [[ -n $ARG_URL_FILE ]]; then
        [[ -f $ARG_URL_FILE ]] || die "--url-file: $ARG_URL_FILE not found"
        ARG_URL=$(head -n 1 "$ARG_URL_FILE")
        # A one-time hand-over: the only copy that stays is /etc/default/gma-kiosk.
        rm -f "$ARG_URL_FILE"
    elif [[ -n $ARG_URL && ${SUDO_COMMAND-} == *device=* ]]; then
        warn "sudo has logged this command line, pairing token included, to the journal."
        warn "Next time use the prompt or --url-file (pi/remote/push-update.sh --url does)."
    fi
    URL=${ARG_URL:-$(config_get KIOSK_URL)}
    if [[ -z $URL ]]; then
        [[ -t 0 ]] || die "no pairing URL: pass --url 'https://$EXPECTED_HOST/grandma?device=...' (from /admin)"
        printf '    Paste the pairing URL from /admin (input hidden): '
        read -r -s URL
        printf '\n'
    fi
    URL=${URL//[[:space:]]/}
    [[ $URL =~ ^https://[A-Za-z0-9.-]+(:[0-9]+)?/grandma\?device=[A-Za-z0-9_-]{32,}$ ]] ||
        die "that does not look like a pairing URL (https://$EXPECTED_HOST/grandma?device=<43-character token>)"
    ORIGIN=$(origin_of "$URL")
    if [[ $ORIGIN != "https://$EXPECTED_HOST" ]]; then
        warn "the URL is for $ORIGIN, not https://$EXPECTED_HOST (fine for a test server)"
    fi

    local night=${ARG_NIGHT:-$(config_get NIGHT_START 21:00)-$(config_get NIGHT_END 07:00)}
    [[ $night =~ ^([01][0-9]|2[0-3]):[0-5][0-9]-([01][0-9]|2[0-3]):[0-5][0-9]$ ]] ||
        die "--night must look like 21:00-07:00 (24-hour, zero-padded)"
    NIGHT_START=${night%-*}
    NIGHT_END=${night#*-}

    NIGHT_PCT=${ARG_NIGHT_PCT:-$(config_get NIGHT_BRIGHTNESS_PERCENT 10)}
    [[ $NIGHT_PCT =~ ^[0-9]+$ ]] && (( NIGHT_PCT >= 1 && NIGHT_PCT <= 100 )) ||
        die "--night-brightness must be 1-100 (never 0: a tap must still show something)"
    DAY_PCT=$(config_get DAY_BRIGHTNESS_PERCENT 100)
    OFF_AT_NIGHT=${ARG_OFF_AT_NIGHT:-$(config_get DISPLAY_OFF_AT_NIGHT 0)}
    DISPLAY_OUTPUT=$(config_get DISPLAY_OUTPUT "")
    HEALTH_URL=$(config_get HEALTH_URL "")
    OFFLINE_URL=$(config_get OFFLINE_URL "")

    TIMEZONE=${ARG_TIMEZONE:-$(config_get TIMEZONE America/Chicago)}
    [[ -e /usr/share/zoneinfo/$TIMEZONE ]] || die "unknown time zone: $TIMEZONE"

    log "pairing URL: $(mask_url "$URL")"
    log "night: $NIGHT_START-$NIGHT_END (DSI brightness ${NIGHT_PCT}% at night), time zone: $TIMEZONE"
}

set_timezone_and_clock() {
    step "Time zone and clock"
    if [[ $(timedatectl show -p Timezone --value 2>/dev/null) != "$TIMEZONE" ]]; then
        timedatectl set-timezone "$TIMEZONE"
        log "time zone set to $TIMEZONE"
        mark_dirty display
    fi
    timedatectl set-ntp true 2>/dev/null || warn "could not turn NTP on (is systemd-timesyncd installed?)"
    log "NTP synchronised now: $(timedatectl show -p NTPSynchronized --value 2>/dev/null || echo '?')"
}

set_hostname() {
    [[ -n $ARG_HOSTNAME ]] || return 0
    step "Hostname"
    [[ $ARG_HOSTNAME =~ ^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$ ]] || die "bad hostname: $ARG_HOSTNAME (lowercase letters, digits, dashes)"
    if [[ $(hostname) != "$ARG_HOSTNAME" ]]; then
        hostnamectl set-hostname "$ARG_HOSTNAME"
        log "hostname set to $ARG_HOSTNAME"
    fi
    if grep -q '^127\.0\.1\.1[[:space:]]' /etc/hosts; then
        sed -i "s/^127\.0\.1\.1[[:space:]].*/127.0.1.1\t$ARG_HOSTNAME/" /etc/hosts
    else
        printf '127.0.1.1\t%s\n' "$ARG_HOSTNAME" >>/etc/hosts
    fi
    # cloud-init would put the Imager hostname back at the next boot.
    if [[ -d /etc/cloud/cloud.cfg.d ]]; then
        printf '%s\n' "# Installed by the gma kit (install.sh --hostname): keep the hostname set here." \
            "preserve_hostname: true" "manage_etc_hosts: false" >/etc/cloud/cloud.cfg.d/99-gma-kiosk.cfg
    fi
}

pkg_installed() { dpkg-query -W -f='${db:Status-Status}' "$1" 2>/dev/null | grep -qx installed; }

install_packages() {
    step "Packages"
    if (( SKIP_APT )); then
        log "skipped (--skip-apt)"
        return 0
    fi
    local p missing=()
    for p in "${PACKAGES[@]}" "${EXTRA_PACKAGES[@]}"; do
        pkg_installed "$p" || missing+=("$p")
    done
    # Install only what is missing: "apt-get install chromium" on an installed
    # chromium would upgrade it, skipping gma-update's keep-the-old-one step.
    if (( ${#missing[@]} )); then
        log "installing: ${missing[*]}"
        export DEBIAN_FRONTEND=noninteractive
        apt-get update
        apt-get install -y --no-install-recommends "${missing[@]}"
        mark_dirty kiosk
    else
        log "all packages present"
    fi
    # Pinned to the installed Chromium's version: installing the candidate
    # chromium-sandbox could drag a newer (or held-back) Chromium along with it.
    local chromium_ver
    chromium_ver=$(dpkg-query -W -f='${Version}' chromium 2>/dev/null || true)
    for p in "${OPTIONAL_PACKAGES[@]}"; do
        pkg_installed "$p" && continue
        [[ -n $chromium_ver ]] || continue
        if apt-cache show "$p=$chromium_ver" >/dev/null 2>&1; then
            DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends "$p=$chromium_ver" ||
                warn "could not install optional $p"
        else
            log "$p $chromium_ver is not in the archive; Chromium uses its namespace sandbox"
        fi
    done
    # rpi-chromium-mods (a Recommends) adds --force-renderer-accessibility and
    # --enable-remote-extensions through /etc/chromium.d. Remove it when nothing
    # else depends on it.
    if pkg_installed rpi-chromium-mods; then
        if [[ $(apt-get -s purge rpi-chromium-mods 2>/dev/null | grep -c '^Purg') == 1 ]]; then
            DEBIAN_FRONTEND=noninteractive apt-get purge -y rpi-chromium-mods && log "removed rpi-chromium-mods"
            mark_dirty kiosk
        else
            warn "rpi-chromium-mods is installed and other packages need it; its extra Chromium flags stay"
        fi
    fi
    if pkg_installed unattended-upgrades; then
        log "unattended-upgrades is installed: leave Raspberry Pi's archive out of it (Chromium updates go through gma-update)"
    fi
    log "chromium $(dpkg-query -W -f='${Version}' chromium 2>/dev/null || echo '?'), cage $(dpkg-query -W -f='${Version}' cage 2>/dev/null || echo '?')"
}

create_kiosk_user() {
    step "The kiosk user"
    if ! id "$KIOSK_USER" >/dev/null 2>&1; then
        useradd --create-home --home-dir "/home/$KIOSK_USER" --shell /usr/sbin/nologin \
            --user-group --comment "gma kiosk (Chromium)" "$KIOSK_USER"
        log "created user $KIOSK_USER"
    fi
    passwd -l "$KIOSK_USER" >/dev/null 2>&1 || true
    local g
    for g in video render audio input; do
        if ! getent group "$g" >/dev/null; then
            warn "group $g does not exist"
        elif [[ " $(id -nG "$KIOSK_USER") " != *" $g "* ]]; then
            usermod -aG "$g" "$KIOSK_USER"
            log "added $KIOSK_USER to $g"
            mark_dirty kiosk
        fi
    done
    if [[ " $(id -nG "$KIOSK_USER") " == *" sudo "* ]]; then
        gpasswd -d "$KIOSK_USER" sudo >/dev/null && log "removed $KIOSK_USER from sudo"
    fi
    # Keep the user's PipeWire running across kiosk restarts and give the
    # helpers a stable /run/user/<uid>.
    loginctl enable-linger "$KIOSK_USER" 2>/dev/null || warn "could not enable linger for $KIOSK_USER"
}

write_config() {
    step "Writing $CONFIG"
    local tmp key line extra=""
    tmp=$(mktemp /etc/default/.gma-kiosk.XXXXXX)
    # Keep any keys someone added by hand.
    if [[ -r $CONFIG ]]; then
        while IFS= read -r line; do
            [[ $line =~ ^[[:space:]]*([A-Z_][A-Z0-9_]*)= ]] || continue
            key=${BASH_REMATCH[1]}
            case " $KNOWN_KEYS " in *" $key "*) continue ;; esac
            extra+="$line"$'\n'
        done <"$CONFIG"
    fi
    {
        echo "# Settings for Grandma's frame (root:kiosk 0640). Written by pi/install.sh;"
        echo "# hand edits survive re-runs (command-line flags win). After editing:"
        echo "#   sudo systemctl restart gma-kiosk gma-display"
        echo "#"
        echo "# The pairing URL from /admin. It is a SECRET: never commit it, paste it in"
        echo "# chat or show it in a screenshot. If it leaks: revoke the frame in /admin,"
        echo "# pair again, then re-run: sudo ./install.sh --url '<new URL>'"
        echo "KIOSK_URL=\"$URL\""
        echo
        echo "# Grandma's time zone (install.sh sets the system clock to it)."
        echo "TIMEZONE=\"$TIMEZONE\""
        echo
        echo "# Night window, local time, may cross midnight. Keep it the same as /admin's night hours."
        echo "NIGHT_START=\"$NIGHT_START\""
        echo "NIGHT_END=\"$NIGHT_END\""
        echo
        echo "# DSI panel only: backlight percent. Night is never 0, so a tap still shows something."
        echo "NIGHT_BRIGHTNESS_PERCENT=\"$NIGHT_PCT\""
        echo "DAY_BRIGHTNESS_PERCENT=\"$DAY_PCT\""
        echo
        echo "# HDMI panel only: 1 = switch the output off at night (taps will not wake it;"
        echo "# it comes back at NIGHT_END). 0 = leave it on and let the web app dim it."
        echo "DISPLAY_OFF_AT_NIGHT=\"$OFF_AT_NIGHT\""
        echo "# Which output to switch (empty = all), e.g. HDMI-A-1. See: sudo gma-display --status"
        echo "DISPLAY_OUTPUT=\"$DISPLAY_OUTPUT\""
        echo
        echo "# Optional overrides; the defaults come from KIOSK_URL."
        if [[ -n $HEALTH_URL ]]; then echo "HEALTH_URL=\"$HEALTH_URL\""; else echo "#HEALTH_URL=\"$ORIGIN/healthz\""; fi
        if [[ -n $OFFLINE_URL ]]; then echo "OFFLINE_URL=\"$OFFLINE_URL\""; else echo "#OFFLINE_URL=\"$ORIGIN/grandma/\""; fi
        if [[ -n $extra ]]; then
            echo
            echo "# Other settings kept from the previous file"
            printf '%s' "$extra"
        fi
    } >"$tmp"
    chown "root:$KIOSK_USER" "$tmp"
    chmod 0640 "$tmp"
    if [[ -f $CONFIG ]] && cmp -s "$tmp" "$CONFIG"; then
        rm -f "$tmp"
        chown "root:$KIOSK_USER" "$CONFIG"
        chmod 0640 "$CONFIG"
        log "unchanged"
    else
        mv -f "$tmp" "$CONFIG"
        log "written (0640 root:$KIOSK_USER)"
        mark_dirty both
    fi
}

has_active_lines() { grep -qvE '^[[:space:]]*(#|$)' "$1" 2>/dev/null; }

install_files() {
    step "Installing the kit's files"
    local f name tmp
    install_file "$FILES/usr/local/lib/gma-kiosk/common.sh" /usr/local/lib/gma-kiosk/common.sh 0644 root:root both
    install_file "$FILES/usr/local/bin/gma-chromium" /usr/local/bin/gma-chromium 0755 root:root kiosk
    install_file "$FILES/usr/local/bin/gma-display" /usr/local/bin/gma-display 0755 root:root display
    for name in gma-netwatch gma-update gma-status gma-screenshot; do
        install_file "$FILES/usr/local/bin/$name" "/usr/local/bin/$name" 0755 root:root
    done

    for f in "$FILES"/etc/systemd/system/*.service "$FILES"/etc/systemd/system/*.timer; do
        name=${f##*/}
        case $name in
            gma-kiosk.service) install_file "$f" "/etc/systemd/system/$name" 0644 root:root "units kiosk" ;;
            gma-display.service) install_file "$f" "/etc/systemd/system/$name" 0644 root:root "units display" ;;
            *) install_file "$f" "/etc/systemd/system/$name" 0644 root:root units ;;
        esac
    done
    install_file "$FILES/etc/systemd/system/systemd-time-wait-sync.service.d/gma-kiosk.conf" \
        /etc/systemd/system/systemd-time-wait-sync.service.d/gma-kiosk.conf 0644 root:root units
    install_file "$FILES/etc/pam.d/gma-kiosk" /etc/pam.d/gma-kiosk 0644 root:root kiosk

    # Chromium policy, pointed at the origin of the pairing URL.
    tmp=$(mktemp)
    sed "s#__ORIGIN__#$ORIGIN#g" "$FILES/etc/chromium/policies/managed/gma.json.in" >"$tmp"
    jq -e . "$tmp" >/dev/null || die "the rendered Chromium policy is not valid JSON"
    install_file "$tmp" /etc/chromium/policies/managed/gma.json 0644 root:root kiosk
    rm -f "$tmp"

    install_file "$FILES/etc/NetworkManager/conf.d/90-gma-kiosk.conf" \
        /etc/NetworkManager/conf.d/90-gma-kiosk.conf 0644 root:root nm
    install_file "$FILES/etc/systemd/journald.conf.d/90-gma-kiosk.conf" \
        /etc/systemd/journald.conf.d/90-gma-kiosk.conf 0644 root:root journald

    # WirePlumber device choice: the kit's copy wins once it names real devices;
    # until then, keep a version Ben filled in on the Pi itself.
    local wp_src=$FILES/etc/wireplumber/wireplumber.conf.d/51-gma-default-devices.conf
    local wp_dst=/etc/wireplumber/wireplumber.conf.d/51-gma-default-devices.conf
    if [[ -f $wp_dst ]] && has_active_lines "$wp_dst" && ! has_active_lines "$wp_src"; then
        log "kept $wp_dst (it names devices; the kit's copy is still the placeholder)"
    else
        if [[ -f $wp_dst ]] && has_active_lines "$wp_dst" && ! cmp -s "$wp_src" "$wp_dst"; then
            cp -f "$wp_dst" "$wp_dst.gma-bak"
            log "replacing $wp_dst with the kit's copy (old one saved as .gma-bak)"
        fi
        install_file "$wp_src" "$wp_dst" 0644 root:root "audio kiosk"
    fi

    # The guide, for whoever is at the Pi.
    for f in "$KIT_DIR/README.next.md" "$KIT_DIR/README.md"; do
        if [[ -f $f ]]; then
            install_file "$f" /usr/local/share/doc/gma-kiosk/README.md 0644 root:root
            break
        fi
    done
}

configure_network() {
    step "Network"
    local uuid type changed=0
    # Per-profile too, for profiles that set these explicitly.
    while IFS=: read -r uuid type; do
        [[ $type == 802-11-wireless ]] || continue
        # -g prints one value per line; enums may read "2 (disable)", so keep the number.
        if [[ $(nmcli -g connection.autoconnect-retries,802-11-wireless.powersave connection show "$uuid" 2>/dev/null | awk '{ print $1 }' | tr '\n' ' ') != "0 2 " ]]; then
            if nmcli connection modify "$uuid" connection.autoconnect-retries 0 802-11-wireless.powersave 2 2>/dev/null; then
                log "Wi-Fi profile $(nmcli -g connection.id connection show "$uuid"): retry forever, power saving off"
                changed=1
            else
                warn "could not modify Wi-Fi profile $uuid (the global default in conf.d still applies)"
            fi
        fi
    done < <(nmcli -t -f UUID,TYPE connection show 2>/dev/null || true)
    if (( DIRTY_NM || changed )); then
        # Reload, never restart: a restart would drop this SSH session. The
        # settings apply the next time the connection comes up.
        nmcli general reload conf 2>/dev/null || systemctl reload NetworkManager.service 2>/dev/null || true
        log "NetworkManager settings reloaded (they apply at the next reconnect or reboot)"
    else
        log "unchanged"
    fi
}

configure_journald() {
    step "Persistent logs (journald, 50 MB cap)"
    mkdir -p /var/log/journal
    systemd-tmpfiles --create --prefix /var/log/journal >/dev/null 2>&1 || true
    local f
    for f in /usr/lib/systemd/journald.conf.d/*.conf /etc/systemd/journald.conf.d/*.conf; do
        [[ -f $f ]] || continue
        if grep -q '^Storage=volatile' "$f" && [[ ${f##*/} > 90-gma-kiosk.conf ]]; then
            warn "$f sorts after 90-gma-kiosk.conf and keeps the journal volatile"
        fi
    done
    if (( DIRTY_JOURNALD )); then
        systemctl restart systemd-journald.service
        journalctl --flush 2>/dev/null || true
        log "journald restarted"
    fi
    if [[ -d /var/log/journal/$(cat /etc/machine-id 2>/dev/null) ]]; then
        log "journal is on disk"
    else
        warn "the journal is not on disk yet (check: systemd-analyze cat-config systemd/journald.conf)"
    fi
}

# Set or replace one KEY=VALUE token on the single line of cmdline.txt.
cmdline_set() {
    local token=$1 key=${1%%=*} f=$BOOT_DIR/cmdline.txt line new w found=0
    local -a words out
    [[ -f $f ]] || { warn "$f not found; skipped $token"; return 0; }
    line=$(head -n 1 "$f")
    read -r -a words <<<"$line"
    out=()
    for w in "${words[@]}"; do
        if [[ ${w%%=*} == "$key" ]]; then
            out+=("$token"); found=1
        else
            out+=("$w")
        fi
    done
    (( found )) || out+=("$token")
    new="${out[*]}"
    [[ $new == "$line" ]] && return 0
    [[ -f $f.gma-orig ]] || cp -p "$f" "$f.gma-orig"
    printf '%s\n' "$new" >"$f"
    log "cmdline.txt: $token"
    REBOOT_NEEDED=1
}

config_txt_block() { # overlay-or-empty
    local f=$BOOT_DIR/config.txt overlay=$1 tmp begin='# >>> gma-kiosk' end='# <<< gma-kiosk'
    [[ -f $f ]] || { warn "$f not found"; return 0; }
    tmp=$(mktemp)
    awk -v b="$begin" -v e="$end" '$0 == b { skip = 1; next } $0 == e { skip = 0; next } !skip' "$f" >"$tmp"
    if [[ -n $overlay ]]; then
        printf '%s\n[all]\ndtoverlay=%s\n%s\n' "$begin" "$overlay" "$end" >>"$tmp"
    fi
    if cmp -s "$tmp" "$f"; then
        rm -f "$tmp"
        return 0
    fi
    [[ -f $f.gma-orig ]] || cp -p "$f" "$f.gma-orig"
    cat "$tmp" >"$f"
    rm -f "$tmp"
    if [[ -n $overlay ]]; then log "config.txt: dtoverlay=$overlay"; else log "config.txt: gma overlay removed"; fi
    REBOOT_NEEDED=1
}

configure_boot() {
    step "Boot settings ($BOOT_DIR)"
    # No console blanking; night mode is explicit (gma-display), never idle-based.
    cmdline_set consoleblank=0
    if (( ARG_FORCE_HOTPLUG )); then
        cmdline_set vc4.force_hotplug=1
    fi
    case $ARG_DSI_OVERLAY in
        "") ;;
        none) config_txt_block "" ;;
        *)
            [[ $ARG_DSI_OVERLAY =~ ^[A-Za-z0-9_.,=-]+$ ]] || die "bad --dsi-overlay value"
            config_txt_block "$ARG_DSI_OVERLAY"
            ;;
    esac
    (( REBOOT_NEEDED )) || log "unchanged"
}

enable_services() {
    step "Services"
    systemctl daemon-reload
    if systemctl cat seatd.service >/dev/null 2>&1; then
        systemctl enable --now seatd.service >/dev/null 2>&1 || warn "could not start seatd"
    fi
    systemctl enable systemd-time-wait-sync.service >/dev/null 2>&1 || warn "could not enable systemd-time-wait-sync"
    systemctl --global enable pipewire.socket pipewire-pulse.socket wireplumber.service >/dev/null 2>&1 ||
        warn "could not enable the PipeWire user services globally"
    systemctl enable gma-kiosk.service gma-display.service gma-netwatch.timer gma-kiosk-restart.timer >/dev/null
    systemctl start gma-netwatch.timer gma-kiosk-restart.timer
    log "enabled: gma-kiosk, gma-display, gma-netwatch.timer, gma-kiosk-restart.timer (03:30)"

    if (( DIRTY_DISPLAY )) || ! systemctl is-active --quiet gma-display.service; then
        systemctl restart gma-display.service
    fi

    # WirePlumber reads its conf.d only at start, and linger keeps it running
    # across kiosk restarts, so a new device choice needs its own restart.
    if (( DIRTY_AUDIO )); then
        local kuid
        kuid=$(id -u "$KIOSK_USER")
        if [[ -d /run/user/$kuid/systemd ]] &&
            runuser -u "$KIOSK_USER" -- env XDG_RUNTIME_DIR="/run/user/$kuid" \
                systemctl --user try-restart wireplumber.service; then
            log "restarted the kiosk user's WirePlumber (new default devices)"
        else
            warn "could not restart the kiosk user's WirePlumber; the new devices apply at the next reboot"
        fi
    fi

    if (( NO_RESTART )); then
        log "kiosk not restarted (--no-restart)"
    elif (( DIRTY_KIOSK )) || ! systemctl is-active --quiet gma-kiosk.service; then
        log "restarting the kiosk"
        systemctl restart gma-kiosk.service
    else
        log "kiosk unchanged, left running"
    fi
}

summary() {
    step "Checks"
    local health=${HEALTH_URL:-$ORIGIN/healthz}
    if curl -fsS -o /dev/null --max-time 10 "$health" 2>/dev/null; then
        log "server: answers at $health"
    else
        warn "server: no answer at $health (no internet, wrong clock, or Ben's server is down)"
    fi
    if compgen -G '/sys/class/backlight/*' >/dev/null; then
        log "panel: DSI backlight found: hardware dimming at night"
    else
        log "panel: no backlight: HDMI panel, the web app dims with CSS (DISPLAY_OFF_AT_NIGHT=$OFF_AT_NIGHT)"
    fi
    sleep 3
    log "kiosk: $(systemctl is-active gma-kiosk.service 2>/dev/null || true)"

    step "Done"
    log "Look at the frame: it should show the Grandma screen, not a 'not set up' page."
    log "In /admin, the frame's 'last seen' should update within a minute."
    log "Health any time: sudo gma-status    Logs: journalctl -u gma-kiosk -b"
    if (( REBOOT_NEEDED )); then
        log "Boot settings changed: reboot to apply them (sudo systemctl reboot)."
    fi
}

preflight
resolve_settings
set_timezone_and_clock
set_hostname
install_packages
create_kiosk_user
write_config
install_files
configure_network
configure_journald
configure_boot
enable_services
summary
