# Decisions

What was chosen, when, and why. The options and the research behind them are in [`phase1-options.md`](phase1-options.md) and [`research/`](research/). The resulting contract is [`ARCHITECTURE.md`](ARCHITECTURE.md).

## 2026-10-22: Design direction: Heirloom

**Chosen**: Heirloom ("the family album on Grandma's kitchen table"), for both the frame and the family PWA. Mocks are in `design/heirloom/`.

- Palette: paper `#F5EEE2`, card `#FFFDF8`, ink `#2B2119` (13.7:1 on paper), muted ink `#57473A` (7.7:1), terracotta `#8A3517` for primary actions (cream text 7.6:1), sage `#3A5236` for Home/OK/Back (8.2:1), antique gold `#B8862B` only as decoration. Night: warm brown `#1E1712` with cream `#F3E8D6`.
- Type: Fraunces for names, headings and the words people wrote; Atkinson Hyperlegible Next (Braille Institute, made for low vision) for everything tappable. Grandma's text is never under 22 px; buttons are at least 80 px (main actions about 100 to 180 px).
- Grafts from the other directions, as recommended: **Lantern's night screen** (the slideshow rests behind a big calm clock) and **a larger photo on Home** (Heirloom's weak spot was the photo at about 25 % of the screen).
- Why: dark text on a warm light background reads best for older eyes in a lit room; it was the most legible and calmest of the three (critic scores 9/9), and its print-and-note-card language makes "who sent this" obvious.

## 2026-10-22: Architecture: Option A, media on the homelab

**Chosen**: one Node app on Ben's Debian homelab, with the media stored there.

- Fastify 5 + `better-sqlite3` (WAL) on Node 24 LTS. One Docker image, two services (`app`, `worker`); named volumes for the database and the media. nginx → Cloudflare Tunnel.
- Uploads go through tus in 32 MB chunks (Cloudflare caps a request at 100 MB; a minute of 4K iPhone video is 300 to 400 MB).
- The worker pre-processes everything on the server: HEIC → JPEG/WebP (`heif-dec` + sharp), video → 720p H.264/AAC MP4 with a poster (HDR tone-mapped, location stripped), voice → AAC M4A. The Pi and every phone play the same files.
- Why: simplest to build and run, one language, one database file, no monthly cost. **Ben is fine with the app being down when his home internet is down**, and his connection is good, so there's no need to put media on R2.
- Accepted risk: Cloudflare's CDN terms restrict serving video from outside Cloudflare on self-serve plans. At family scale this is a grey area with low risk. The code keeps media behind a storage module, so moving renditions to R2 later is contained.

## 2026-10-22: Storage: media on the Seagate drive, the database on the SSD

**Chosen**: photos and videos (originals, renditions and the tus upload scratch, all on one filesystem so finishing an upload is a rename) live on the server's Seagate Portable 1.8 TB USB 3 drive at `/mnt/seagate/gma/media`. The SQLite database stays on the internal SSD (Docker named volume `gma_data`).

- Measured 2026-10-22: sequential write 74.5 MB/s, sequential read 49.7 MB/s, a cold random read of a 300 KB photo 15.7 ms, but an fsync'd small write 164 ms. Media is fine there: one 720p stream is about 0.4 MB/s, and uploads are limited by phones' uplinks. A database is not, because SQLite fsyncs on every commit.
- Compose mounts the media as a named volume bound to `/mnt/seagate/gma/media` (local driver, `type: none, o: bind`). If the drive isn't mounted, that path doesn't exist and the containers refuse to start, rather than writing photos onto the SSD under an empty mount point. The app also checks for a `.gma-media` sentinel file at start.
- The drive is shared with Encore and Docket (it already holds about 200 GB of theirs), and it is mounted with `nofail` before Docker starts. gma adds no fstab entries.
- **Backups (Ben, 2026-10-22): no extra copies on local disks.** The external drive is the single place everything gma needs lives, and Ben will add a daily cloud backup of that drive, assuming it will fail someday. So the worker writes a consistent nightly snapshot of the database onto the drive (`/mnt/seagate/gma/media/backups/gma-YYYY-MM-DD.sqlite`, made with SQLite's backup API, keeping the last 7). A cloud copy of the drive then holds the photos, the videos and a restorable database. A live SQLite file copied mid-write isn't reliably restorable; the snapshot is.
- Until that cloud backup exists, losing the drive loses the media. This is accepted for the draft, which has no real family data. The drive's SMART health is unknown (`smartctl` isn't installed).

## 2026-10-22: Deployment: gma's own tunnel container, no nginx

**Chosen**: on Ben's Debian box gma runs like his other apps there: `/home/ben/gma` with `docker-compose.yml` at the repo root and `.env` beside it, and three containers on a fixed subnet (`10.35.0.0/24`): `gma-app`, `gma-worker` and `gma-tunnel`, gma's own named Cloudflare tunnel (`c0773eb4-…`, config in `deploy/cloudflared.yml`) going straight to `http://app:8080`. This replaces the "nginx → Cloudflare Tunnel" line of the architecture decision above.

- Why: nothing is published on the LAN (only `127.0.0.1:3064`, for checks from the box), nginx-proxy-manager and the host's `/etc/cloudflared` stay untouched, and one less hop means one less thing to break. The nginx site stays in `deploy/nginx/` as an optional note.
- The app believes `CF-Connecting-IP` only from the tunnel's address (`TRUST_PROXY=10.35.0.3`, pinned in compose with `MEDIA_SENTINEL`, `DATA_DIR` and `MEDIA_DIR`, so a typo in `.env` can't move the data or widen the trust). The containers run as uid 1000 with a read-only root, no capabilities and a tmpfs `/tmp`; the worker is capped at 3 CPUs and ffmpeg at two threads.

## 2026-10-22: Family sign-in: invite + email code, then passkeys

**Chosen**: an invite link, then a 6-digit email code typed in the app, then an offer to "Use Face ID next time" (a passkey). Later sign-ins use Face ID / Touch ID / the phone's fingerprint, with the email code as the fallback and the recovery path. No passwords.

- Why the code (not only a magic link): an iPhone home-screen app has its own cookie jar, and links from Mail open in Safari, so a link alone would sign in Safari, not the app. The email also carries a link to a confirm page that needs a tap, so mail scanners can't burn it.
- Why passkeys: Ben asked for biometrics "like a passcode" once the app is set up. A passkey lives in the phone's keychain (iCloud Keychain / Google Password Manager), not in the app's cookie jar, so the one made in Safari during onboarding also works in the installed app. Verified (`research/passkeys-research.json`): WebAuthn is the only web route to biometrics; it works in the installed iOS app and on Android (Chrome, Google Password Manager); it must start from a tap; iPhones need iCloud Keychain on. An optional "Unlock with Face ID" app lock is possible later, but it isn't on by default (friction for older relatives).
- Sessions last 400 days and slide, so most relatives sign in once. Removing someone deletes their sessions, passkeys and push subscriptions.
- Email: Resend's free tier (3,000 a month, 100 a day: invites are staggered), sending from `auth.4mn.org` with SPF, DKIM and DMARC.

## 2026-10-22: Product defaults (Ben: "the rest looks good")

These were the recommended defaults in Phase 1; each is a setting or a small change if Ben wants otherwise.

- **Grandma's Feed is shared**: every relative sees every reaction, preset and voice note, with the photo it was about and who it went to (VISION as written). A reaction or preset still notifies only the photo's sender.
- **Reactions**: ❤️ Love, 😂 Funny, 😮 Wow, 🙏 Thankful (drawn as Noto emoji SVGs, so the Pi renders them too).
- **Presets**: "Love you", "Call me", "Thank you", "Miss you all", "So beautiful", "Made my day", "Come visit soon", "Proud of you". Ben edits them in `/admin`; family suggestions are a later feature.
- **Uploads go live at once**; Ben can hide or delete any item. Videos up to 3 minutes and 2 GB per file; voice notes up to 60 seconds.
- **Night**: 21:00 to 07:00 by default, set in `/admin`; the frame dims, the slideshow rests behind a big clock, and the first tap only wakes it.
- **Grandma's frame**: the same PWA at `/grandma`, a Chromium kiosk under cage on Raspberry Pi OS Lite (trixie), paired once with a device token; live updates over SSE, not web push.
- **Updates and offline**: the web app updates itself; the frame caches the newest ~300 photos and queues anything Grandma sends while offline.

## 2026-10-22: Review fixes: what was changed, and what waits

- **Family voice notes on an upload are deferred.** VISION → Sending lists "an optional caption or voice note"; the draft ships captions only. The schema already allows it (`voice_notes.item_id`, deleted with the item), so it can come later without a migration: a record button under the caption (at most 60 s) and a big "Hear Sarah" button on Grandma's item screen that plays only on a tap. Until then, a caption is the way to say what a photo is.
- **`EMAIL_TRANSPORT=console` stays allowed in production** for the first days of a deploy, before Resend is set up for `auth.4mn.org` (the README's bootstrap). It prints messages to the app log, so an invite it "sent" never counts as emailed: opening it still asks for a code. Switch to `resend` before inviting the family.
- **Limits on a shared box**: per person, 200 files and 10 GB of uploads a day and 120 new uploads an hour; a new upload must leave 50 GB free on the Seagate drive; images over 120 MP are refused; compose caps the app at 1 GB, the worker at 3 GB and the tunnel at 256 MB. After 15 wrong sign-in codes in a day, that email gets no codes until the next day.

## 2026-10-22: What Grandma calls people, HDR video, upgrades

- **Short names**: Grandma's frame shows what she calls each person ("Mike", "Uncle Mike", "Aunt Carol"), never the full name. The default is the first word, or family/title words plus the next word (up to three words, e.g. "Great Aunt Mary"), from one 49-word list shared by `server/src/lib/people.js`, migration 005 and `web/shared/names.js`. The join form asks "What does Grandma call you?" (prefilled), and Ben can change it in `/admin`.
- **HDR iPhone video** is scaled to 720p *before* the tone map. Measured on the homelab: a 4K 10-bit HLG clip transcodes at 0.32× real time with the worker's 3 CPUs, against 0.05× before. The ffmpeg timeout scales with the clip's length.
- **Upgrades** take a database snapshot onto the drive before applying any new migration.

## 2026-10-22: Phase 3: the draft lives on gma.4mn.org itself

- Ben (2026-10-22): build right on gma.4mn.org (no `draft.` subdomain). Nobody gets a link until he says so. It stays invite-only and `noindex`, with only fake family data, until then.
- Host: the Debian homelab (`ben@192.168.68.69`), in `/home/ben/gma`. 4mn.org's DNS is on Cloudflare; the one new record is `gma.4mn.org → tunnel gma`.

## Still open

- Pi hardware: which 10" panel (DSI with hardware dimming vs HDMI + USB touch), SD vs USB SSD, the mic array, the speaker, Wi-Fi vs Ethernet at Grandma's (Phase 4).
- Resend for `auth.4mn.org` (SPF/DKIM/DMARC) before inviting the family; until then codes are printed in `docker compose logs app`.
- A daily cloud backup of the Seagate drive (Ben's plan).
