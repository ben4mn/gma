# gma.4mn.org: Phase 1 options

2026-10-22. Design directions and architecture options, for Ben to pick from. Nothing here is decided until it lands in `docs/DECISIONS.md` (Phase 2).

- Mocks: `design/index.html` (overview), `design/<direction>/{home,photo,family}.html` with states (`?state=offline|night` on home, `?state=presets|sent|video` on photo, `?tab=grandma|mine` on family). Screenshots and contact sheets are in `design/<direction>/shots/`.
- Shared brief: `design/BRIEF.md`. Audit: `design/tools/shoot.py` (tap targets ≥ 80 px, text ≥ 20 px, contrast ≥ 7:1, or 4.5:1 for large text, no scrolling, no autoplay, no network). All three directions pass on all 10 screens.
- Research with every source URL: `docs/research/phase1-research.json` (two research passes plus an adversarial fact check).

## 1. Visual directions

All three use the same screens, the same fake family and the same Noto emoji SVGs for the reactions. Use SVGs because Raspberry Pi OS has no colour emoji font by default. Fonts are self-hosted (OFL) with no runtime requests.

| | Heirloom | Front Porch | Lantern |
|---|---|---|---|
| Mood | The family album on Grandma's kitchen table: warm paper, printed photos with white mats, notes beside them | Big, bright and unmistakable, like a good TV remote: one fixed frame, chunky keys, a colour per meaning | A quiet gallery at dusk: the photo glows, everything else steps back |
| Polarity | Dark on warm light | Black on white (true black at night) | Light on near-black |
| Core palette | paper `#F5EEE2`, card `#FFFDF8`, ink `#2B2119` (13.7:1), muted `#57473A` (7.7:1), terracotta `#8A3517` (cream on it 7.6:1), sage `#3A5236` (8.2:1), gold `#B8862B` decorative only | white `#FFFFFF`, surface `#F1F3F6`, ink `#0F1419` (18.5:1), ink-2 `#3D4652` (9.6:1), action blue `#0A47C2` (7.8:1); tiles: Love `#A8102A`, Funny `#F5B400`, Wow `#5E3593`, Thankful teal | room `#101215`, surface `#1B1F24`, raised `#262B31`, ivory `#F4EFE6` (16.4:1), muted `#CFC7BA` (9.9:1), honey `#F2B544` (10.3:1) with ink `#1A1406`, rose `#F2A7B0` for Love |
| Type | Fraunces (names, captions, notes) + Atkinson Hyperlegible Next (everything tappable) | Atkinson Hyperlegible Next only, 650 to 800 weight | Lexend (UI) + Literata (the words people wrote) |
| Grandma scale (px/weight) | clock 56/600 · name 54/600 · title 46 · preset 38 · caption 30/400 · button 28/700 · reaction 26/700 · meta 24 | hero 48/800 · clock 46 · title 42 · preset 36 · reaction 34/800 · body 32/650 · small 26 · min 22 | night clock 184/300 · clock 52 · title 44/700 · name 40 · preset 34 Literata · caption 30 · body 28 · label 26/600 · min 22 |
| Family scale | title 30 · name 19 · caption 18 · body 17 · tab 13 | title 32/800 · name 20 · button 19 · body 17 · tab 14 | title 30/700 · name 17 · caption 17 · body 15–16 · tab 13 |
| Home button | top-left, sage; outlined on Home ("you're here") | top-left, outlined key with a lip; flat on Home | bottom-left in the dock, honey ring on Home |
| Night mode | Same layout in warm brown, photos dimmed and sepia, slideshow rests | True black and white, tiles dimmed, slideshow rests | Slideshow stops behind a huge calm clock; "See the photos now" |
| Critic scores (legibility / calm / who-it-goes-to / photo-first / touch / family app / craft) | 9 / 9 / 9 / **6.5** / 9 / 8 / 8.5 | 9 / 8 / 9 / 7 / 9 / 8 / **7** | 8.5 / 9 / 8.5 / **8** / 8.5 / 8.5 / 8.5 |
| Main risk | The open photo is about 25 % of the screen (mat + note + reactions) | Can read as toy-like on the phone; heavy frames around photos | Light-on-dark can halo for eyes with cataracts and looks murky in a sunny room |
| Best for | A lit kitchen or living room; a grandma who loves albums | Low vision, a tremor or early memory loss | A dim room, evenings, a bedroom |

Recommendation: **Heirloom**, with Lantern's night screen (big clock, slideshow resting) and a larger photo on Home. Dark text on a light background reads best for older eyes in a lit room. If the frame lives somewhere dim, pick Lantern.

Mock data note: Heirloom's Grandma's Feed shows each relative only what Grandma sent to them or to everyone. The other two show everyone every item, with whom it went to, which is how VISION.md reads. This is a product rule (open question 3), not part of the look.

## 2. Architecture options

### Facts that shape every option (verified 2026-10-22)

| Fact | Consequence |
|---|---|
| Cloudflare caps a proxied request body at **100 MB** on Free/Pro, and Tunnel hostnames are proxied (413 at the edge). A 1-minute 4K iPhone video is 300–400 MB. | Uploads must be **chunked/resumable** (tus, 16–32 MB chunks) or go direct to R2 with presigned multipart. |
| Cloudflare's CDN terms (updated 2026-09-28) restrict serving **video and large files** on self-serve plans unless they're hosted on R2/Stream/Images. The terms don't exempt uncached or authenticated responses. Enforcement against small personal use is anecdotally rare. | Video from the homelab through the tunnel is technically in the restricted case. Renditions on R2 are the compliant path. |
| Proxy read timeout 125 s. Tunnel buffers responses unless they are `text/event-stream`. | Transcoding is always an async job (202 + job id). SSE needs the exact content type and nginx `proxy_buffering off`. |
| An **iOS Home Screen web app has its own cookie jar**. Since iOS 17.2, Safari's cookies (only) are copied in at install. Mail links open in Safari, never in the installed app. | A pure magic link signs in Safari, not the installed PWA. Email a **6-digit code** (typed in the app, `autocomplete="one-time-code"`) plus a link to a confirm page. Onboard as "sign in, then Add to Home Screen" so the cookie carries over. |
| Mail scanners (Defender Safe Links and others) open links before people do. | An emailed GET must never consume a token. The link lands on a page whose button POSTs. |
| iOS web push needs iOS 16.4+, an installed Home Screen app and a permission request from a tap. Safari revokes subscriptions after silent pushes. Declarative Web Push works on iOS 18.4+. There is no `pushsubscriptionchange` on iOS. | Send declarative-format payloads and keep a service worker handler. Re-sync the subscription on every launch. Prune on 404/410. Use one stable VAPID key with a real `mailto:`. |
| iPhones deliver **HEIC** photos (with `accept="image/*"`). Library videos are re-encoded on the phone to full-size H.264 .MOV, so they don't shrink. HDR is 10-bit HLG/Dolby Vision. | The server decodes HEIC and tone-maps HDR. |
| sharp's prebuilt binaries can't read HEIC, and sharp 0.35 needs a newer libvips than Debian trixie ships. Debian trixie's `libheif`/`vips`/`ffmpeg` handle HEIC, HEVC, zscale and x264 out of the box. | A worker image on `debian:trixie-slim` + `ffmpeg libvips-tools libheif-examples`: HEIC → `heif-dec`/`vips`, then prebuilt sharp. |
| Chromium on Raspberry Pi OS plays **no HEVC**. It hardware-decodes H.264 up to 1080p (V4L2). Builds 151–152 rpt1 could freeze the GPU on looping clips (fixed in 152.0.7977.82 rpt2). | Every video gets an 8-bit H.264/AAC MP4, ≤ 1080p (720p for the Pi), `+faststart`, `-map_metadata -1` (iPhone .MOVs carry GPS). One `<video>` at a time. |
| Chromium's MediaRecorder gives WebM/MP4 Opus, which some iPhones play badly. | Transcode Grandma's voice notes to AAC .m4a (64 kbps mono). |
| PocketBase v0.40.5 is still pre-1.0 (breaking changes in v0.23 and v0.40). It has OTP (no magic link), localStorage tokens, no resumable uploads, thumbnails only for JPG/PNG/GIF and no video posters. | PocketBase skips the easy parts and leaves the two hard ones (big uploads, media) to sidecars. |
| Node 24 is Maintenance LTS (2026-10-20); Node 26 becomes Active LTS on 2026-10-28. Fastify 5.12 is current. better-sqlite3 13 needs Node 22+. node:sqlite is a release candidate. Litestream v0.5.17 replicates to R2/B2 (one replica, no client-side encryption). | Fastify 5 + better-sqlite3 on Node 24/26, with Litestream offsite plus a nightly snapshot. |
| R2: $0.015/GB-month, free egress, 10 GB free. Presigned URLs work only on the S3 endpoint and expire in ≤ 7 days. | About $0–1/month at family scale. Signed URLs need care with video Range requests and service-worker cache keys. |

### The options

| | **A. Lean Node monolith, media on the homelab** | **B. Same app, renditions on R2** | **C. PocketBase + sidecars** |
|---|---|---|---|
| Shape | `app` (Fastify 5 + better-sqlite3, serves the PWA, API, SSE, tus) + `worker` (trixie-slim: ffmpeg, vips, libheif; SQLite jobs table). Named volumes `gma-db`, `gma-media`. nginx → tunnel. | As A. The worker also uploads renditions (posters, 400 px thumbs, 1280×800 display, 2048 px phone, 720p MP4, m4a) to a private R2 bucket. Originals stay home as the archive. | PocketBase (auth, CRUD, admin UI, realtime) + a Node sidecar for tus, transcoding and push. |
| Containers | 2 | 2 (+ an R2 bucket, maybe a small Worker for auth) | 2–3, two runtimes (Go + goja hooks, and Node) |
| Simplicity | One language, one DB file, code you own end to end | One extra moving part: signed URLs or a Worker checking the session | Fastest CRUD and admin, but the hard parts are still custom, split across two systems |
| Ops burden | Lowest: `docker compose up`, Litestream + a nightly media sync offsite | Low; plus R2 credentials and CORS | Medium: pin and track a pre-1.0 binary, two upgrade paths |
| Media | Full control. Served from Ben's uplink through the tunnel. | Same pipeline. Served from Cloudflare's edge, so the home uplink isn't hit when 40 phones open a video. | Same sidecar work as A, plus metadata shuttling between PocketBase and the sidecar |
| Push | web-push from the app: identical in A/B/C (it's a platform matter) | same | Needs the sidecar; PocketBase has no push |
| Cloudflare terms | Video through the tunnel: grey area, low risk at family scale | Compliant | Same as A |
| Cost | $0 (plus email) | ~$0–1/month | $0 |
| Admin (invite, remove, moderate) | Build a small /admin | same | Built-in dashboard (raw, not family-friendly) |

**Recommendation: A, with a storage interface (`local` | `r2`) from day one, so moving to B is a config change.** A is enough for the gated draft. Switch to B before real family video if you want to be clean under Cloudflare's terms, or if your uplink is slow.

### Per decision

| Decision | Options | Recommend |
|---|---|---|
| Backend | Fastify + SQLite · Fastify + Postgres · PocketBase | **Fastify 5 + better-sqlite3 (WAL), Node 24 → 26 LTS.** Postgres adds a container and a backup story for ~40 users and one writer. |
| Uploads | single POST (dies at 100 MB) · tus chunks · presigned R2 multipart | **tus (`@tus/server` 2.x in Fastify, `tus-js-client`/Uppy), 32 MB chunks**, 2 GB cap; "keep the app open" UX (iOS has no background upload) |
| Media storage | local volume · MinIO · R2 | **Local named volume** for originals and renditions; R2 renditions behind the interface (B). MinIO adds a container and gives one box nothing a volume doesn't. |
| Images | sharp prebuilt · vips CLI · ImageMagick | `heif-dec`/`vips` for HEIC → prebuilt sharp `autoOrient().resize()`. EXIF/GPS stripped by default. |
| Video | 720p · 1080p · both | **720p H.264 8-bit + poster for everyone** (fine on phones, ideal for the Pi), HDR tone-mapped, GPS stripped; keep the original |
| Job queue | SQLite table · Redis/BullMQ | **SQLite `jobs` table**, video concurrency 1, idempotent, stale-lock reclaim at boot |
| Family sign-in | magic link · code · code + link | **Invite link → name + email → 6-digit code (10–15 min, 5 tries) + confirm-page link → session cookie (long-lived, httpOnly).** Install the PWA after sign-in. |
| Email sender | Resend · Postmark · SES · Gmail SMTP · Cloudflare Email Service | **Resend free** (3k/month, 100/day: stagger the 40 invites), from `auth.4mn.org` with SPF/DKIM/DMARC. Postmark ($15/month) if deliverability bites. |
| Web push | web-push · Web Crypto libs | **web-push** with declarative payloads (`web_push: 8030`), TTL 1–3 days, coalesced per day via `tag`/topic |
| Grandma live updates | web push · SSE · polling | **SSE + 60 s poll fallback.** Distro Chromium may not be able to subscribe to push at all. |
| Grandma auth | device token → cookie | Ben pairs in /admin. `/grandma?device=<token>` swaps for a device cookie and redirects without the token. The kiosk URL keeps the token, so a wiped profile re-pairs itself. Log redaction for `device`. |
| Grandma offline | SW app shell · LRU media cache · IndexedDB outbox | All three: cache the newest ~300 renditions, call `navigator.storage.persist()`, queue reactions, presets and voice notes, retry on `online` + timer |
| Pi software | Chromium kiosk · Electron · Tauri/flutter-pi | **Chromium kiosk under cage on Pi OS Lite 64-bit (trixie)**, Raspberry Pi's own pattern; flags + managed policies (mic pre-granted to `https://gma.4mn.org`, translate/autofill off, URL allowlist) |
| Pi storage | overlayroot · ext4 on SSD · overlay + `/data` | **Plain ext4 on a USB SSD** (a plain overlay wipes the profile, the cache and Tailscale's identity every boot) |
| Pi recovery | | Built-in watchdog (on by default), `cage@tty1` `Restart=always`, start after `time-sync.target` (no RTC), NetworkManager retry forever + a connectivity watchdog, nightly kiosk restart |
| Pi updates | unattended-upgrades · maintenance script | **The app updates itself** (service worker; reload at 3 am). OS: a monthly health-checked script with Chromium rollback from the Raspberry Pi pool. Tailscale `--ssh --auto-update`, tagged so keys don't expire. |
| Backups | | Litestream → R2/B2 (DB) + nightly `sqlite3 .backup`; restic/rclone of originals to R2/B2 |

## 3. Open questions

1. **Direction**: Heirloom, Front Porch or Lantern? Any grafts (for example Lantern's night clock on Heirloom)?
2. **Architecture**: A (media at home) or B (renditions on R2: clean under Cloudflare's terms and spares your uplink)? What is your home upload speed?
3. **Grandma's Feed visibility**: does everyone see every item and whom it went to (VISION as written), or does each relative see only what was sent to them or to everyone? And should the presets screen say "goes to Sarah" (a notification) or "Sarah only" (private)?
4. **Sign-in**: OK to make the email's 6-digit code the main path, with the link as the fallback? A link alone can't sign in an installed iPhone app.
5. **Email**: Resend free OK? Is 4mn.org's DNS on Cloudflare (for SPF/DKIM records, and for Cloudflare Email Service if you already pay for Workers)?
6. **Pi hardware**: which 10" panel? A DSI panel (e.g. Waveshare 10.1" DSI (C)) gives hardware dimming; HDMI + USB touch means CSS dimming plus screen off. Raspberry Pi's own 10" Touch Display 2 doesn't work on a Pi 4. Also: SD or USB SSD, which mic array, which speaker, Wi-Fi or Ethernet at Grandma's?
7. **Night**: what hours, and dim + clock or fully dark? The first tap at night only wakes the screen.
8. **Content rules**: the final 8 presets, and can family suggest new ones (you approve)? Are the reaction labels Love / Funny / Wow / Thankful right? Video cap (my default: 3 min, 2 GB)? Do uploads go live at once with you able to remove them (my default), or wait for approval?
9. **Offsite backup target**: R2, B2, or a restic repo you already run?
10. Heads-up for Phase 3: I'll need the SSH host/user (or Tailscale name), and whether you want `draft.gma.4mn.org` (it can sit behind Cloudflare Access, free up to 50 users, but never in front of `/grandma` or the installed iPhone app).
