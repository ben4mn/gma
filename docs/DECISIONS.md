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

## Still open

- Pi hardware: which 10" panel (DSI with hardware dimming vs HDMI + USB touch), SD vs USB SSD, the mic array, the speaker, Wi-Fi vs Ethernet at Grandma's (Phase 4).
- 4mn.org DNS (for the email records) and the offsite backup target (Phase 3).
- Phase 3: the SSH host and whether to use a separate `draft.` subdomain.
