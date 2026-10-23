# Grandma's frame: the Raspberry Pi kiosk

The frame is a Raspberry Pi 4 with a 10" touchscreen, a USB microphone and a speaker. It runs Chromium full screen (in `cage`, a one-window Wayland compositor) at the pairing URL from `/admin`. There is nothing for Grandma to manage: it starts by itself, recovers by itself after a power cut or a Wi-Fi drop, and Ben looks after it remotely over Tailscale.

Everything here is in `pi/` in the repo. The repo is private, so the Pi never pulls from GitHub: Ben's machine pushes the kit to it (`pi/remote/push-update.sh`).

| Piece | What it does |
|---|---|
| `install.sh` | Run as root on the Pi. Installs packages, the kiosk user, the units, the Chromium policy, night mode, the watchdog. Safe to re-run. |
| `files/` | Everything `install.sh` copies onto the Pi, at the same paths (`/usr/local/bin/gma-*`, `/etc/systemd/system/gma-*`, …). |
| `remote/` | Scripts Ben runs on his own machine: `push-update.sh`, `screenshot.sh`, `reload.sh`, `logs.sh`, `status.sh`. |
| `cloud-init/` | Example `user-data` and `network-config` for the boot partition. |
| `tailscale.md` | Joining the tailnet with a tagged key, and the SSH policy. |

## 1. Hardware

| Part | Choice | Notes |
|---|---|---|
| Computer | Raspberry Pi 4, 4 GB | |
| Power | The official Raspberry Pi 15 W (5.1 V, 3 A) USB-C supply | Cheap supplies cause under-voltage: random freezes, Wi-Fi drops, a corrupted card. `gma-status` shows "under-voltage seen" if it happens. All USB devices together may draw at most 1.2 A. |
| Storage | A USB 3 SSD, or a high-endurance A2 microSD card (32 GB or more) | The Pi 4 boots from USB without any EEPROM change (it tries the SD slot first, then USB). An SSD survives years of writes and power cuts better than a card. |
| Screen | A 10.1" 1280×800 touchscreen; see below | **Raspberry Pi's own 10" Touch Display 2 does not work on a Pi 4** (it needs the Pi 5's 4-lane DSI). |
| Microphone | A USB mic array (e.g. ReSpeaker USB Mic Array v2.0) or a USB speakerphone | A USB speakerphone (mic and speaker in one, with hardware echo cancelling) is the simplest. |
| Speaker | USB speaker, or powered speakers on the 3.5 mm jack | A DSI panel has no HDMI audio. |
| Case/stand | Something that hides the cables and keeps the Pi ventilated | |

**Choosing the panel** (not decided yet; the kit supports both):

| | DSI panel (e.g. Waveshare 10.1" DSI LCD (C)) | HDMI + USB-touch panel (e.g. Waveshare 10.1" HDMI LCD (B)) |
|---|---|---|
| Night dimming | **Real backlight dimming** from software (`/sys/class/backlight`) | No software brightness: the web app dims the picture with CSS, and the backlight stays on |
| Power | From the Pi (about 0.5 A with the backlight on) | About 0.75 A: **power it separately**, not from the Pi's USB |
| Setup | One line in `config.txt`: `install.sh --dsi-overlay vc4-kms-dsi-waveshare-panel,10_1_inch` | Plug and play; `--hdmi-force-hotplug` if the panel powers up after the Pi |
| Risk | Waveshare documents the trixie overlay for Pi 5/CM4 and the Pi 4 only on older releases: **bench-test one on a Pi 4 before buying a second** | Cursor may appear (touch controllers often also act as a mouse; the web app hides it with CSS) |

Recommendation from the research: DSI, for real dimming at night, after a bench test.

## 2. Flash the card (or SSD)

1. Install **Raspberry Pi Imager 2.x** (1.9.x cannot customise trixie images).
2. Choose *Raspberry Pi 4* → *Raspberry Pi OS (other)* → **Raspberry Pi OS Lite (64-bit)** (Debian 13 trixie).
3. In the customisation screens:
   - Hostname: `gma-frame`
   - User: `kiosk-admin`, with **SSH public-key authentication only** (paste Ben's public key). No password login.
   - Wi-Fi: Grandma's network name and password, country **US**.
   - Locale: time zone `America/Chicago`, keyboard `us`.
   - Enable SSH.
4. Write it. Imager puts `user-data`, `network-config` and `meta-data` (cloud-init) on the boot partition. `cloud-init/user-data.example` and `network-config.example` show the same settings if you want to check or hand-edit them.
5. Sudo: new trixie images no longer give passwordless sudo. If `kiosk-admin` has a password (Imager asks for one), sudo asks for it, and the remote scripts work anyway because they all run sudo through `ssh -t`. If the account has **no** password (`lock_passwd: true`, as in `user-data.example`), it must have `sudo: "ALL=(ALL) NOPASSWD:ALL"`, as in the example, or nobody can ever become root on the frame. A password also matters for a local login with a keyboard (Ctrl+Alt+F2); without one, the only way in is SSH.

## 3. First boot

1. Connect the panel, the mic, the speaker, then the power. The first boot takes a few minutes (it resizes the filesystem and runs cloud-init).
2. From Ben's machine on the same network: `ssh kiosk-admin@gma-frame.local` (or the IP from the router).
3. Optional but recommended now: set up Tailscale (`tailscale.md`). After that, everything below works from anywhere, using `gma-frame` as the host.

## 4. Install the kiosk

1. In `/admin`, pair a new frame. Copy the pairing URL: `https://gma.4mn.org/grandma?device=<token>`.
   **The token is a secret.** Never commit it, paste it in chat, or put it in a screenshot. It lives only on the Pi, in `/etc/default/gma-kiosk` (owner root, group kiosk, mode 0640).
2. From the repo on Ben's machine:

   ```bash
   pi/remote/push-update.sh gma-frame            # install.sh prompts for the URL (hidden input)
   # or, for a DSI panel:
   pi/remote/push-update.sh gma-frame --dsi-overlay vc4-kms-dsi-waveshare-panel,10_1_inch
   ```

   `push-update.sh` copies `pi/` to `~/gma-kit` on the Pi and runs `sudo bash ~/gma-kit/install.sh`. You can also pass `--url '…'` to `push-update.sh` instead of using the prompt. It goes over SSH's input into a 0600 file that `install.sh --url-file` reads and deletes, so it never appears in a command line on the Pi. Clear it from your own shell history afterwards. **Never run `sudo install.sh --url '…'` on the Pi itself**: sudo logs the whole command line, token included, to the journal, and the journal is kept on disk.

   All `install.sh` options: `--url-file`, `--url`, `--hostname`, `--night 21:00-07:00`, `--timezone America/Chicago`, `--night-brightness 10`, `--display-off-at-night`, `--dsi-overlay …`, `--hdmi-force-hotplug`, `--skip-apt`, `--no-restart`. Re-runs keep the stored URL and settings (flags win), and only restart the kiosk when something changed.
3. If the summary says *Boot settings changed*, reboot: `ssh kiosk-admin@gma-frame sudo systemctl reboot`.

What `install.sh` sets up:

- Packages (`--no-install-recommends`, which keeps out `rpi-chromium-mods` and its extra flags): `chromium cage seatd pipewire pipewire-pulse wireplumber fonts-noto-color-emoji grim wlr-randr brightnessctl curl jq`, plus `dbus-user-session libpam-systemd alsa-utils rsync`. An installed Chromium is never upgraded by `install.sh`; that is `gma-update`'s job.
- A `kiosk` user (no password, no sudo) in the `video render audio input` groups.
- `gma-kiosk.service`: cage on tty1 with a real login session (so PipeWire runs), `Restart=always` every 5 s, never giving up. It waits for the network and a synced clock, but at most about a minute each, so an offline boot still starts.
- `gma-chromium`: Chromium with exactly `--kiosk --ozone-platform=wayland --noerrdialogs --no-first-run --password-store=basic --disable-pinch --disable-features=OverscrollHistoryNavigation --autoplay-policy=no-user-gesture-required --user-data-dir=/var/lib/gma-kiosk/profile` (translate is off by policy, not by a flag).
- The browser profile in `/var/lib/gma-kiosk/profile`, kept across reboots: the saved photos, the outbox of unsent reactions and voice notes, and the device cookie live there.
- Chromium policy `/etc/chromium/policies/managed/gma.json`: microphone allowed for `https://gma.4mn.org` only and never prompted; autoplay and notifications allowed for it; every other site blocked; no translate, passwords, autofill, sign-in, sync, metrics, dev tools, incognito, guest mode, promotions or spellcheck.
- NetworkManager retries forever with Wi-Fi power saving off; journald keeps logs on disk (50 MB cap); no console blanking; `systemd-time-wait-sync` on; a kiosk restart every night at 03:30.
- `gma-display` (night mode), `gma-netwatch` (network watchdog), and Ben's tools `gma-status`, `gma-screenshot`, `gma-update`.

## 5. Check the pairing

- The frame shows Grandma's home screen (photos, the big clock, "Message to the whole family"). A "not set up" page means the token is wrong or revoked (see Troubleshooting).
- In `/admin`, the frame's "last seen" updates within a minute.
- `pi/remote/screenshot.sh gma-frame` shows what is on the screen.
- `pi/remote/status.sh gma-frame` should say *server answers* and *chromium running*.

The server swaps the token for a cookie on the first visit and drops the token from the address bar. If the profile is ever wiped, the next start pairs again by itself from the stored URL.

## 6. Tailscale

See `tailscale.md`: join with a tagged auth key (`tag:gma-kiosk`, which turns key expiry off), `tailscale set --ssh --auto-update`, and an SSH `accept` rule for Ben.

## 7. Night mode

Night is 21:00 to 07:00 by default. Two things happen:

1. **The web app** (driven by the night hours in `/admin`) dims, rests the slideshow behind a big clock, and treats the first tap only as "wake up".
2. **`gma-display`** (on the Pi, driven by `NIGHT_START`/`NIGHT_END` in `/etc/default/gma-kiosk`) checks every minute:
   - **DSI panel:** sets the backlight to `NIGHT_BRIGHTNESS_PERCENT` (default 10 %) at night and `DAY_BRIGHTNESS_PERCENT` (100 %) by day. Never fully off, so a tap always shows something.
   - **HDMI panel:** does nothing (the app's CSS dimming is all there is), unless `DISPLAY_OFF_AT_NIGHT=1`: then it switches the output off with `wlr-randr` at night and on at `NIGHT_END`. Taps do not wake it in that mode.

**Keep the two night windows the same.** Change both: `/admin`, and `install.sh --night 21:30-07:00` (or edit the file and `sudo systemctl restart gma-display`). See what it is doing: `sudo gma-display --status`.

## 8. Sound: microphone and speaker

On the Pi (`ssh kiosk-admin@gma-frame`):

```bash
K="sudo -u kiosk XDG_RUNTIME_DIR=/run/user/$(id -u kiosk)"
$K wpctl status                         # Sinks = speakers, Sources = microphones; * marks the default
arecord -l; aplay -l                    # what the kernel sees (USB devices should be listed)
$K pw-record --channels 1 /tmp/mic.wav  # say something, Ctrl-C after 5 s
$K pw-play /tmp/mic.wav                 # should come out of the speaker
$K wpctl set-volume @DEFAULT_AUDIO_SINK@ 80%
```

If the wrong device is the default, pin the right ones in `files/etc/wireplumber/wireplumber.conf.d/51-gma-default-devices.conf` (the file explains how to find the names; the values are regular expressions, so use `.*`, not `*`), push again, and check `wpctl status`. `install.sh` restarts the kiosk user's WirePlumber when that file changes. Restarting only `gma-kiosk` is not enough: the kiosk user lingers, so WirePlumber keeps running and reads the file only when it starts. This survives reboots; `wpctl set-default` does not survive a profile reset.

The browser asks for the microphone only for `https://gma.4mn.org`, and never shows a prompt. The app pauses playback while Grandma records, so echo is not an issue.

## 9. Remote tools (from Ben's machine)

```bash
pi/remote/status.sh gma-frame        # kiosk, display, network, power, temperature, audio
pi/remote/screenshot.sh gma-frame    # saves gma-screenshot-<time>.png here
pi/remote/reload.sh gma-frame        # restarts the kiosk (a few seconds of black)
pi/remote/logs.sh gma-frame [-f | --previous | --all]
pi/remote/push-update.sh gma-frame   # after changing anything in pi/
```

The SSH user defaults to `kiosk-admin` (`GMA_SSH_USER=other pi/remote/status.sh gma-frame` to change it). A gentler reload than `reload.sh`: `/admin` → the frame → *Reload*, which reloads the page over the live connection without restarting the browser.

## 10. Updates and rollback

Nothing updates itself except Tailscale and the web app (the frame reloads itself on a new version when idle on Home). Raspberry Pi publishes several Chromium builds a month, and a bad one would black out the screen with nobody there to notice, so Ben updates by hand when he can look:

```bash
ssh -t kiosk-admin@gma-frame sudo gma-update
```

It keeps a copy of the current Chromium packages, runs `apt-get update` and `full-upgrade`, restarts the kiosk, and checks that Chromium stays up for 30 seconds. **If the new Chromium does not come up, it rolls back by itself** (`--no-auto-rollback` to skip that). Then look at `/admin`'s "last seen" or take a screenshot: only that confirms the page itself is fine. It says when a reboot is needed for a new kernel (`gma-update --reboot` reboots instead of restarting the kiosk).

If Chromium starts but the page misbehaves (video freezes, for example), roll back by hand:

```bash
ssh -t kiosk-admin@gma-frame sudo gma-update --rollback-chromium            # the version before the last update
ssh -t kiosk-admin@gma-frame sudo gma-update --rollback-chromium 1:155.0.8059.79-1~deb13u1+rpt1
ssh -t kiosk-admin@gma-frame sudo gma-update --status                       # versions, holds, saved copies
ssh -t kiosk-admin@gma-frame sudo gma-update --unhold-chromium              # when a fixed build is out
```

The rollback uses the saved copy, then the apt cache, then `archive.raspberrypi.com`'s pool (which keeps older builds for a while), and **holds** Chromium so the next update leaves it alone until you unhold it.

To change the kit itself (units, scripts, policy), edit `pi/` and run `push-update.sh`.

## 11. Power cuts

- The Pi boots straight back into the frame. There is no "Restore pages?" bubble (`--kiosk` suppresses it, and the launcher marks the last exit clean).
- The Pi 4 has no clock battery. At boot the clock jumps to the last time it was saved, then the kiosk waits up to a minute for the network clock. If there is no internet, it starts anyway and corrects the time when the internet returns.
- The hardware watchdog (on by default in Raspberry Pi OS) reboots a frozen Pi within a couple of minutes. Logs from before a crash are kept (`logs.sh --previous`).
- A power cut can, rarely, corrupt the browser profile. The fix is to delete it; the frame pairs itself again: `ssh kiosk-admin@gma-frame 'sudo systemctl stop gma-kiosk && sudo rm -rf /var/lib/gma-kiosk/profile && sudo systemctl start gma-kiosk'` (the saved photos download again).
- An SSD and the official supply make all of this rarer.

## 12. What Grandma sees when the internet is down

- **The frame was already running:** her saved photos (the newest ~300) keep showing, with one calm line: "No internet right now. Your saved photos keep showing." Reactions, messages and voice notes wait in an outbox and send themselves later.
- **The frame starts (after a power cut) while offline:** the launcher sees the server is unreachable and opens the saved frame (`/grandma/`) from the browser's cache instead of the pairing URL. If nothing was ever saved (a brand-new frame), Chromium shows its error page, and `gma-netwatch` restarts the kiosk the minute the server answers.
- **Behind the scenes** `gma-netwatch` checks every minute. If the internet works but `gma.4mn.org` does not, it is Ben's server or his home internet, and the Pi does nothing. If the Pi has no internet at all: after 3 minutes it switches the Wi-Fi radio off and on, after 10 minutes it restarts NetworkManager, after 30 minutes it reboots (at most once every 6 hours), and it repeats the first two steps every 30 minutes after that. `sudo gma-netwatch --status` shows where it is.

## 13. Troubleshooting

| What you see | Likely cause | What to do |
|---|---|---|
| Black screen | Kiosk crashing in a loop, or the panel not detected | `status.sh` (is Chromium running?), `logs.sh`. DSI: check the ribbon cable and the `--dsi-overlay` line in `/boot/firmware/config.txt`, reboot. HDMI: was the panel powered after the Pi? Use `--hdmi-force-hotplug`, reboot. |
| Text console instead of the frame | `gma-kiosk` not running | `ssh … sudo systemctl status gma-kiosk`, then `logs.sh`. After a new Chromium: `gma-update --rollback-chromium`. |
| "Not set up" page | Token wrong, revoked, or from another frame | Pair again in `/admin`, then `push-update.sh gma-frame --url '<new URL>'`. |
| Chromium "No internet" page | Started offline with nothing saved yet | Wait: it reloads when the server answers. Or `reload.sh`. |
| Certificate or "clock is ahead/behind" error | Clock wrong after a power cut | `ssh … timedatectl` (NTP synchronized?). Once synced: `reload.sh`. |
| No sound | Wrong default device, volume, or speaker power | Section 8: `wpctl status`, `pw-play`. Pin devices in the WirePlumber file. |
| Microphone not working | Mic not the default source, or not detected | `arecord -l`, `wpctl status`. The site must be `https://gma.4mn.org` exactly (the policy allows only that origin). |
| Wi-Fi keeps dropping | Weak signal, power supply, router | `status.sh` (signal %, under-voltage). Move the router or add an access point; use Ethernet if possible. Power saving is already off. |
| New Wi-Fi network at Grandma's | Router replaced | Before the swap, over Tailscale: `sudo nmcli dev wifi connect '<new name>' password '<password>'` (it keeps both profiles). After the swap with no access: a keyboard on the Pi (Ctrl+Alt+F2 for a console; this needs `kiosk-admin` to have a password), or re-flash. |
| Screen too bright or too dim at night (DSI) | Brightness settings | Edit `NIGHT_BRIGHTNESS_PERCENT`/`DAY_BRIGHTNESS_PERCENT` in `/etc/default/gma-kiosk`, `sudo systemctl restart gma-display`. |
| Clock wrong after a power cut | No RTC, no internet yet | It corrects itself once online. Persistently wrong: check the time zone (`--timezone`) and `timedatectl`. |
| A mouse cursor on screen | The touch controller also reports a mouse | The web app hides it with `cursor: none`; if it shows, that page is missing the style. |
| "Under-voltage seen" in status | Weak supply or too much on USB | Use the official 3 A supply; power an HDMI panel separately. |

## 14. Don't

- **Don't turn on the overlay filesystem** (raspi-config's "Overlay File System"). Every reboot would wipe the saved photos, the outbox, the device cookie, Tailscale's identity and the clock file. `install.sh` warns if it is on.
- **Don't let Chromium upgrade unattended.** Don't add Raspberry Pi's archive to unattended-upgrades; use `gma-update` when you can look at the result.
- **Don't add `--disable-infobars`** (or `--disable-session-crashed-bubble`). They no longer exist; `--kiosk` does that job. Change Chromium's behaviour through the policy file, not flags. `--use-fake-ui-for-media-stream` is on Chromium's bad-flags list; the microphone is allowed by policy.
- **Don't put the pairing URL anywhere but `/etc/default/gma-kiosk`**: not in the repo, not in `user-data`, not in a ticket, and not on a `sudo` command line on the Pi (use the prompt or `push-update.sh --url`, see section 4).
- **Don't paste `ps` output from the frame.** Chromium's command line holds the start URL, token included, and any account on the Pi can read it.
- **Don't run `wpctl set-default`** as the fix for audio; pin devices in the WirePlumber file.
- **Don't use swayidle, wlopm or raspi-config's screen blanking.** cage does not support them, and Chromium blocks idle blanking while a video plays anyway. Night mode is explicit.
- **Don't power an HDMI panel from the Pi's USB ports.**
- **Don't run the scripts in `pi/` on anything but the frame** (the remote scripts excepted, which run on Ben's machine).

## Where things are on the Pi

| Path | What |
|---|---|
| `/etc/default/gma-kiosk` | The pairing URL (secret), night hours, brightness, time zone |
| `/var/lib/gma-kiosk/profile` | Chromium's profile (safe to delete: it re-pairs) |
| `/var/lib/gma-kiosk/netwatch` | The watchdog's outage state and last reboot |
| `/var/lib/gma-kiosk/chromium-prev` | Saved Chromium packages for rollback |
| `/usr/local/bin/gma-*` | `gma-chromium`, `gma-display`, `gma-netwatch`, `gma-update`, `gma-status`, `gma-screenshot` |
| `/etc/systemd/system/gma-*` | `gma-kiosk.service`, `gma-display.service`, `gma-netwatch.{service,timer}`, `gma-kiosk-restart.{service,timer}` |
| `/etc/chromium/policies/managed/gma.json` | The Chromium policy |
| `/etc/wireplumber/wireplumber.conf.d/51-gma-default-devices.conf` | Default mic and speaker |
| `/usr/local/share/doc/gma-kiosk/README.md` | This guide |
