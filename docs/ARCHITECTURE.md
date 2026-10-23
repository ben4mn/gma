# Architecture

The contract every part of gma.4mn.org is built against. `VISION.md` says what the app is for; `docs/DECISIONS.md` records why it is built this way. When this file and the code disagree, fix one of them in the same change.

## Shape

```
phones (family PWA) ─┐                         ┌─ app    (Fastify: PWA, API, SSE, tus uploads, media)
                     ├─ Cloudflare Tunnel ─ nginx ─┤
Grandma's Pi (kiosk) ┘                         └─ worker (jobs: images, video, voice → renditions)
                                                     │
                                both read/write  /data/gma.sqlite  (SQLite, WAL)
                                                 /media/originals, /media/renditions  (named volumes)
```

- One Docker image, two services: `app` (`node src/index.js`) and `worker` (`node src/worker.js`). Both share the SQLite database and the media volume.
- Everything runs on Ben's Debian homelab. If his internet is down, the app is down. That's accepted. Grandma's frame keeps showing saved photos (see Offline).
- No external services, except the email sender (Resend) for sign-in codes and the browsers' push services.

## Stack

| Layer | Choice |
|---|---|
| Runtime | Node 24 LTS in Docker (`node:24-trixie-slim`). The code also runs on Node 25 locally. ESM (`"type": "module"`). |
| HTTP | Fastify 5, `@fastify/cookie`, `@fastify/static`, `@fastify/rate-limit` |
| Database | `better-sqlite3` 13, WAL, `busy_timeout=5000`, `foreign_keys=ON`. Migrations are plain SQL files run in order at start. |
| Uploads | tus: `@tus/server` 2 + `@tus/file-store` in Fastify; the browser uses `tus-js-client` 4 (vendored ESM build) with `chunkSize` 32 MB |
| Images | prebuilt `sharp` (JPEG/PNG/WebP/AVIF); HEIC/HEIF is first decoded by the `heif-dec` CLI (Debian `libheif-examples`) |
| Video and voice | `ffmpeg`/`ffprobe` (Debian trixie) spawned by the worker |
| Passkeys | `@simplewebauthn/server` 14 + `@simplewebauthn/browser` 14 (vendored) |
| Push | `web-push` 3.6 (VAPID) |
| Email | Resend REST API via `fetch` (no SDK); `console` transport for dev and tests |
| Frontend | vanilla JS ES modules + custom CSS, no build step, no framework. Heirloom design (`design/heirloom/`). |
| Tests | `node --test` + `fastify.inject` for the server; `node --test` for pure web modules; Playwright 1.58 (headless shell, never Google Chrome) for end-to-end |

## Repository layout

```
server/
  package.json            # all server deps; scripts: start, worker, test, admin:create, device:pair, vapid:gen, seed:demo
  src/
    index.js              # start the app (listen on HOST:PORT)
    worker.js             # start the job loop
    app.js                # buildApp(config) → Fastify instance (no listen; used by tests)
    config.js             # loadConfig(env) → frozen config; throws on missing secrets in production
    db/index.js           # openDb(path) → better-sqlite3 handle, pragmas, migrate()
    db/migrations/NNN_*.sql
    lib/                  # shared, no routes: ids, tokens, time, email, events, sessions, guards, settings, storage, push, media
    routes/*.js           # each file exports `default async function (app, opts)`; app.js registers every file in this folder
    jobs/                 # queue.js (claim/complete/fail), image.js, video.js, voice.js
  scripts/                # CLIs: create-admin.js, pair-device.js, gen-vapid.js, seed-demo.js
  test/                   # *.test.js, helpers/ (makeTestApp, softAuthenticator, fixtures)
web/
  index.html              # the family PWA shell (every family route serves this)
  app/                    # family app modules (router, screens, upload, onboarding, admin)
  grandma/                # index.html, grandma.js, grandma.css, sw.js (scope /grandma/)
  shared/                 # api.js, time.js, sse.js, tokens.css, icons.js
  assets/                 # fonts (Fraunces, Atkinson Hyperlegible Next), emoji SVGs, icons, sample-free
  vendor/                 # tus-js-client, @simplewebauthn/browser (ESM builds + licences)
  sw.js                   # family service worker (scope /)
  manifest.webmanifest
deploy/
  docker-compose.yml, nginx/gma.4mn.org.conf, cloudflared.md, backup.md
Dockerfile                # at the root: the one image (build context = repo root)
pi/                       # kiosk setup (Phase 4)
design/                   # Phase 1 mocks; design/heirloom is the reference for every screen
docs/                     # ARCHITECTURE.md (this), DECISIONS.md, phase1-options.md, research/
```

## Configuration (`.env`, never committed; `.env.example` lists every key)

| Key | Default | Notes |
|---|---|---|
| `NODE_ENV` | `production` | `development` relaxes `Secure` cookies on `http://localhost` |
| `PUBLIC_URL` | `https://gma.4mn.org` | origin used for links, the Origin check, WebAuthn's expected origin |
| `HOST` / `PORT` | `0.0.0.0` / `8080` | inside the container |
| `DATA_DIR` | `/data` | `gma.sqlite` lives here |
| `MEDIA_DIR` | `/media` | `originals/`, `renditions/`, `uploads/` (tus scratch) |
| `SECRET_KEY` | (required) | ≥ 32 random bytes, base64; HMAC key for codes and token hashes |
| `EMAIL_TRANSPORT` | `console` | `resend` in production |
| `RESEND_API_KEY` | | |
| `EMAIL_FROM` | `Grandma's family <hello@auth.4mn.org>` | |
| `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` | (required for push) | `npm run vapid:gen` once; never rotate (it orphans every subscription) |
| `VAPID_SUBJECT` | (required) | a real `mailto:` (Apple rejects placeholders) |
| `WEBAUTHN_RP_ID` | host of `PUBLIC_URL` | `gma.4mn.org` |
| `WEBAUTHN_RP_NAME` | `Grandma's family` | shown in the passkey sheet |
| `MAX_UPLOAD_BYTES` | `2147483648` | 2 GB per file |
| `MAX_VIDEO_SECONDS` | `180` | longer videos fail with a kind message |
| `MAX_VOICE_SECONDS` | `60` | recorder stops itself; server trims at 65 s |
| `TRUST_PROXY` | `true` | behind nginx + cloudflared |
| `LOG_LEVEL` | `info` | |

## Data model (SQLite, `server/src/db/migrations/001_init.sql`)

All ids are 26-char ULIDs (`lib/ids.js::newId()`) except passkey credential ids. All times are integers, milliseconds since the epoch, UTC. Booleans are 0/1.

```sql
users            (id PK, name, email UNIQUE COLLATE NOCASE, role 'admin'|'member', status 'pending'|'active'|'removed',
                  color, created_at, activated_at, removed_at)
invites          (id PK, token_hash UNIQUE, created_by → users, name, email, role, expires_at, used_at, used_by → users,
                  revoked_at, created_at)
login_codes      (id PK, user_id → users, code_hash, link_token_hash UNIQUE, expires_at, attempts, used_at, created_at, ip)
sessions         (id PK, token_hash UNIQUE, kind 'user'|'device', user_id → users NULL, device_id → devices NULL,
                  created_at, last_seen_at, expires_at, user_agent)
passkeys         (id PK /* credential id, base64url */, user_id → users, public_key BLOB, counter, transports JSON,
                  device_type, backed_up, label, created_at, last_used_at)
webauthn_challenges (id PK, user_id NULL, challenge, kind 'register'|'login', expires_at)
devices          (id PK, name, token_hash UNIQUE, created_by → users, created_at, last_seen_at, revoked_at)
items            (id PK, user_id → users, kind 'photo'|'video', caption, batch_id, status 'processing'|'ready'|'failed'|'hidden',
                  error, width, height, duration_ms, original_path, original_mime, original_bytes, created_at, ready_at, hidden_at)
renditions       (item_id → items, name 'thumb'|'display'|'large'|'poster'|'video'|'audio', path, mime, width, height, bytes,
                  PRIMARY KEY (item_id, name))
voice_notes      (id PK, device_id → devices NULL, user_id → users NULL, item_id → items NULL /* a family note on an upload */,
                  status 'processing'|'ready'|'failed', duration_ms, original_path, audio_path, client_id UNIQUE NULL, created_at)
grandma_events   (id PK, device_id → devices, kind 'reaction'|'preset'|'voice', item_id → items NULL, reaction 'love'|'funny'|'wow'|'thankful' NULL,
                  preset_id → presets NULL, preset_text, voice_note_id → voice_notes NULL, recipient_user_id → users NULL /* NULL = everyone */,
                  client_id UNIQUE /* idempotency key from the frame's outbox */, created_at)
item_views       (device_id, item_id, seen_at, PRIMARY KEY (device_id, item_id))   -- "New for you" on the frame
presets          (id PK, text, sort, active, created_at)
push_subscriptions (id PK, user_id → users, endpoint UNIQUE, p256dh, auth, user_agent, created_at, last_success_at, failures)
jobs             (id PK, kind 'image'|'video'|'voice', ref_id, status 'queued'|'running'|'done'|'failed', attempts, max_attempts,
                  run_after, locked_at, locked_by, error, created_at, updated_at)
events           (id INTEGER PK AUTOINCREMENT, topic, audience 'all'|'user:<id>'|'devices', payload JSON, created_at)  -- SSE outbox
settings         (key PK, value JSON)   -- night_start '21:00', night_end '07:00', timezone 'America/Chicago', max_video_seconds …
admin_log        (id PK, user_id, action, target, detail JSON, created_at)
```

Seed rows in the migration: the 8 presets ("Love you", "Call me", "Thank you", "Miss you all", "So beautiful", "Made my day", "Come visit soon", "Proud of you") and the default settings.

## Sessions, auth and devices

- **Cookie** `gma_session`: random 32-byte token (base64url), only its SHA-256 is stored. `HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=34560000` (400 days, Chrome's cap). Each request touches `last_seen_at`; past half its life the expiry is pushed out (sliding). `lib/sessions.js` owns `createSession(db, {kind, userId|deviceId, userAgent})`, `setSessionCookie(reply, token)`, `clearSessionCookie(reply)`, `loadSession(db, token)`, `revokeUserSessions(db, userId)`, `revokeDeviceSessions(db, deviceId)`.
- **Guards** (`lib/guards.js`, Fastify preHandlers): `requireUser`, `requireAdmin`, `requireDevice`, `requireUserOrDevice`. They set `request.user` or `request.device`. Removed users and revoked devices are 401.
- **CSRF**: every state-changing request (`POST/PUT/PATCH/DELETE`) must carry an `Origin` header equal to `PUBLIC_URL`'s origin (tus requests included). JSON bodies only, no form posts, plus SameSite=Lax.
- **Invite** (admin-made, single use, 14 days): `/join/<token>`. If the app emailed the invite to that address, opening the link proves the email and signs them in straight away. If Ben shared the link some other way (a text), they type their name and email and confirm with a code. A user is `pending` until that first sign-in.
- **Email code** (the reliable path on iPhone, where the installed app has its own cookie jar): 6 digits, valid 15 min, 5 attempts, the newest code wins. Stored as an HMAC. The same email carries a link to `/confirm?t=<token>`. That page needs a button tap (a POST) to sign in, so mail scanners that open links can't burn it. Rate limits: 5 code requests per email per hour and 20 per IP per hour. `POST /api/auth/code/request` always answers 200, so it never reveals who has an account.
- **Passkeys** ("Use Face ID next time"): after the first sign-in (and after any code sign-in on a device without one, at most 3 offers), the app offers to create a passkey (discoverable credential, `residentKey: 'required'`, `userVerification: 'required'`, attestation `none`, RP ID `gma.4mn.org`). Later sign-ins use "Sign in with Face ID" (a usernameless `navigator.credentials.get`). The email code stays as the fallback and the recovery path. Verified rules (`docs/research/passkeys-research.json`): `create()`/`get()` run only from a tap, never on load; no conditional/autofill UI (it is unreliable in the installed iOS app); challenges are server-side, single use, 5 min; `requireUserVerification: true`; synced passkeys keep counter 0 (not a clone signal); one gentle error for every `NotAllowedError` ("That didn't work. Try again or get an email code."). iCloud Keychain must be on for iPhone passkeys; the code path covers everyone else. Grandma's frame never uses passkeys. A user can hold several passkeys and remove them on the You screen. Removing a user deletes their passkeys and sessions.
- **Grandma's frame**: Ben pairs a device in `/admin` (or `npm run device:pair`). That makes a 32-byte token, shown once as `https://gma.4mn.org/grandma?device=<token>`. `GET /grandma?device=` checks the token, creates a `device` session (cookie), and 302s to `/grandma/` with the token stripped from the URL. The kiosk launches with that URL, so a wiped browser profile pairs itself again at the next boot. Request logs redact the `device`, `t` and `token` query parameters.

## HTTP API

JSON in and out. Errors are `{error: {code, message}}`, and `message` is a sentence a person can read. Pagination is `?before=<id>&limit=` with ULID cursors.

| Area | Route | Guard | Notes |
|---|---|---|---|
| Health | `GET /healthz` | public | `{ok, db, worker_last_seen}` |
| Invites | `GET /api/invites/:token` | public | `{valid, name, email}` |
| | `POST /api/invites/:token/accept` `{name, email}` | public | creates/updates the pending user, sends a code |
| Auth | `POST /api/auth/code/request` `{email}` | public | always 200 |
| | `POST /api/auth/code/verify` `{email, code}` | public | sets the session; `{user, offer_passkey}` |
| | `POST /api/auth/link/confirm` `{token}` | public | the `/confirm` page's button |
| | `POST /api/auth/passkey/register/options` / `…/verify` | user | |
| | `POST /api/auth/passkey/login/options` / `…/verify` | public | usernameless |
| | `POST /api/auth/logout` | user | |
| Me | `GET /api/me` | user | `{user, passkeys: n, push: bool}` |
| | `GET /api/me/passkeys`, `DELETE /api/me/passkeys/:id` | user | |
| Items | `GET /api/items?scope=family\|mine&before=` | user | ready items (plus your own processing/failed on `mine`), renditions, Grandma's reactions per item |
| | `GET /api/items/:id`, `PATCH /api/items/:id` `{caption}`, `DELETE /api/items/:id` | user (owner or admin) | |
| Uploads | `ALL /api/uploads/*` (tus) | user | metadata `filename, filetype, caption, batch_id`; on finish → item `processing` + job |
| Media | `GET /media/:itemId/:name` | user or device | Range support, `Cache-Control: private, max-age=31536000, immutable`; URLs carry `?v=<ready_at>` |
| | `GET /media/voice/:voiceId` | user or device | the m4a |
| Grandma's Feed | `GET /api/grandma-events?before=` | user | reactions, presets, voice notes; each with the item thumb, the sender and the recipient |
| Frame | `GET /grandma?device=<token>` | public | pairs, 302 → `/grandma/` |
| | `GET /api/frame/state` | device | `{now, settings, presets, slideshow: [items], new: [cards grouped by batch], family_photo}` |
| | `POST /api/frame/seen` `{item_ids}` | device | |
| | `POST /api/frame/react` `{item_id, reaction, client_id}` | device | idempotent on `client_id`; push to the item's owner |
| | `POST /api/frame/preset` `{item_id, preset_id, client_id}` | device | idempotent; push to the owner |
| | `POST /api/frame/voice` (multipart `audio`, `client_id`, ≤ 5 MB) | device | idempotent on `client_id`; creates a `processing` voice note + a `voice` job. The job, when the m4a is ready, creates the `grandma_events` row (kind `voice`, recipient NULL), publishes `grandma.event` and pushes to everyone |
| | `POST /api/frame/heartbeat` `{version, online_since}` | device | updates `last_seen_at` |
| Push | `GET /api/push/key`, `POST /api/push/subscribe`, `POST /api/push/unsubscribe`, `POST /api/push/test` | user | |
| Live | `GET /api/events` (SSE) | user or device | `text/event-stream`, `X-Accel-Buffering: no`, a comment every 25 s, `Last-Event-ID` resume |
| Admin | `GET /api/admin/people`, `POST /api/admin/invites` `{name, email, role, send}`, `DELETE /api/admin/invites/:id`, `POST /api/admin/people/:id/remove`, `POST /api/admin/people/:id/restore` | admin | `remove` revokes sessions, passkeys and push subscriptions; their uploads stay unless deleted |
| | `GET /api/admin/items?status=`, `POST /api/admin/items/:id/hide`, `…/unhide`, `DELETE /api/admin/items/:id` | admin | |
| | `GET /api/admin/devices`, `POST /api/admin/devices` `{name}` (returns the pairing URL once), `POST /api/admin/devices/:id/revoke`, `POST /api/admin/devices/:id/reload` | admin | `reload` sends an SSE `reload` to the frame |
| | `GET/PUT /api/admin/presets`, `GET/PUT /api/admin/settings`, `GET /api/admin/health` | admin | health: queue depth, failed jobs, disk free, frame last seen |

Pages (all serve the family shell `web/index.html` unless noted): `/` Family, `/from-grandma` Grandma's Feed, `/mine`, `/upload`, `/join/:token`, `/signin`, `/confirm`, `/you`, `/admin`, `/admin/*`; `/grandma/` serves `web/grandma/index.html`.

## Live events (SSE)

The `events` table is an outbox. Anything that changes state (the app or the worker) inserts a row (`lib/events.js::publish(db, topic, payload, audience)`). The app polls it every second and fans new rows out to connected clients that match the audience. Event ids are the row ids, so `Last-Event-ID` resumes after a reconnect. Topics: `item.ready`, `item.removed`, `item.failed` (owner only), `grandma.event`, `settings.changed`, `frame.reload` (devices). Rows older than 7 days are deleted.

## Media pipeline (worker)

`jobs` is claimed with `UPDATE … SET status='running', locked_at=?, locked_by=? WHERE id = (SELECT id FROM jobs WHERE status='queued' AND run_after<=? ORDER BY created_at LIMIT 1) RETURNING *`. Concurrency: video 1, image 2, voice 1. Retries back off exponentially (30 s, 2 min, 10 min), with 3 attempts. At boot, `running` jobs locked more than 30 minutes ago are requeued. Jobs are idempotent: each writes to a temp path and renames into place. The worker writes `worker_last_seen` to settings every 15 s.

| Input | Steps | Renditions |
|---|---|---|
| Photo (JPEG/PNG/WebP/HEIC/HEIF/AVIF) | HEIC/HEIF → `heif-dec in out.png`; then sharp `.autoOrient()`; metadata (EXIF, GPS) is dropped by default | `thumb` 480 px WebP q72 · `display` 1600 px JPEG q82 (the frame and the feed) · `large` 2560 px JPEG q85 (tap to zoom); each `fit: inside, withoutEnlargement` |
| Video (MOV/MP4/M4V/3GP/WebM) | `ffprobe` (duration, rotation, colour transfer); reject > `MAX_VIDEO_SECONDS`; HDR (`arib-std-b67`/`smpte2084`) → zscale tone map; `ffmpeg -map 0:v:0 -map 0:a:0? -map_metadata -1 -vf scale=-2:'min(720,ih)',format=yuv420p -c:v libx264 -profile:v high -preset veryfast -crf 23 -maxrate 3M -bufsize 6M -c:a aac -b:a 128k -ac 2 -movflags +faststart`; a poster frame at 1 s (0 s if shorter) | `video` 720p H.264/AAC MP4 · `poster` 1600 px JPEG · `thumb` 480 px WebP |
| Voice (WebM/Opus, MP4/AAC, Ogg) | `ffmpeg -t 65 -map_metadata -1 -ac 1 -c:a aac -b:a 64k` | `audio` M4A |

Originals are kept under `/media/originals/<yyyy>/<mm>/<id>.<ext>` and never served. Renditions live under `/media/renditions/<id>/<name>.<ext>`. Deleting an item deletes both.

## Push (who gets what)

`lib/push.js` exports `sendToUser(db, config, userId, payload)`, `sendToAll(db, config, payload)` and `notifyGrandmaEvent(db, config, eventId)` (builds the payload below from the event and sends it to the right people; safe to call from the app or the worker). Reactions and presets call it from the frame route right after inserting the event; voice notes call it from the voice job.

| Grandma does | Push goes to | Payload (declarative web push, ≤ 2 KB) |
|---|---|---|
| Reacts to a photo | the item's owner | `{"web_push": 8030, "notification": {"title": "Grandma loved your photo", "body": "❤️ Love · “Lily at the farm…”", "navigate": "<PUBLIC_URL>/from-grandma#e-<id>", "tag": "grandma-<item_id>"}}` |
| Sends a preset | the item's owner | title `Grandma sent you a message`, body `“Call me” · about your photo` |
| Records a voice note | every active user | title `Grandma sent a voice message`, body `Tap to listen (0:42)`, tag `grandma-voice-<id>` |

TTL 2 days, urgency `normal`. A 404/410 deletes the subscription. Other failures increment `failures`, and the subscription is dropped after 5 in a row. The service worker's `push` handler always calls `showNotification` with the same fields, so iOS never revokes it for a silent push. Its `notificationclick` focuses or opens `navigate`. The client re-syncs its subscription each time the app opens. On iOS the Enable button only appears in standalone mode, and it requests permission from that tap.

## Frontend

**Family PWA** (`web/index.html` + `web/app/`), phone-first, Heirloom style (`design/heirloom/family.html`):
- Bottom tabs: **Family** (`/`), **Grandma's Feed** (`/from-grandma`), **Mine** (`/mine`); a header with a Share button (upload) and the user's initial (→ `/you`).
- Onboarding: `/join/<token>` → name + email → code → in Safari, "Use Face ID next time?" (a passkey) → "Add to your Home Screen" guide (iOS share-sheet steps; Android install prompt) → in the installed app, "Turn on notifications".
- Upload: pick several photos/videos, an optional caption, then per-file progress (tus resumes after a drop) and "Keep this open until it finishes" (iOS can't upload in the background). Items show "Getting it ready…" until `item.ready`.
- Viewing: tap a card for a full-screen photo (pinch to zoom) or a video with native controls. Nothing autoplays.
- Grandma's Feed: every reaction, preset and voice note in time order, each showing which photo it was about and who it went to (VISION: everyone sees the feed). Voice notes play inline on a tap.
- `/you`: name, passkeys (add/remove), notifications on/off/test, sign out. `/admin` (admins only): people and invites, uploads (hide/delete), the frame (pair, revoke, reload, last seen), presets, night hours.

**Grandma mode** (`web/grandma/`), 1280×800, Heirloom with Lantern's night screen (`design/heirloom/home.html`, `photo.html`; `design/lantern/home.html?state=night`):
- Home: an ambient slideshow of the newest photos (a crossfade every 40 s; portraits whole, never cropped), "New for you" cards grouped by batch ("3 photos from Mike", "Video from Sarah"), the "Message to the whole family" button, a big clock, and Home top-left on every screen.
- An item: the photo or video poster, sender, when, caption; 4 labelled reactions; "Send a message" → 8 presets ("It goes to Sarah only. One tap sends it."); a warm "Sent to Sarah" confirmation that returns by itself after 4 s; Previous/Next. A video plays only on a tap, in one `<video>` element created on tap and destroyed on leave.
- Voice: a big red record button, a visible countdown from 60 s that stops itself, hear it back, then "Send to everyone". The screen says plainly that the whole family will hear it.
- Night (default 21:00–07:00, set in admin): dimmed, the slideshow rests behind a big calm clock; the first tap only wakes the screen.
- Offline: one calm line ("No internet right now. Your saved photos keep showing."); reactions, presets and voice notes queue and send themselves later.
- Idle: any screen returns to Home after 2 minutes untouched.
- Kiosk hygiene: `cursor: none`, no text selection, no context menu, no pinch, the screen kept awake (Wake Lock) outside night hours. A new version reloads itself only when the frame is on Home and idle.

**Service workers**: `web/sw.js` (scope `/`) precaches the family shell and caches renditions for the feed. `web/grandma/sw.js` (scope `/grandma/`) precaches the frame shell, keeps an LRU cache of the newest ~300 `display` and `poster` renditions (plus the newest few videos, capped at 500 MB), serves `/api/frame/state` network-first with the last good copy as fallback, and calls `navigator.storage.persist()`. The frame's **outbox** (IndexedDB) holds reactions, presets and voice notes with their `client_id`, and retries on `online` and every 30 s.

## Security and privacy

- Nothing public: every page except `/join`, `/signin`, `/confirm`, `/grandma?device=` and `/healthz` needs a session. Every response carries `X-Robots-Tag: noindex, nofollow`; `robots.txt` disallows all.
- Headers: a strict CSP (`default-src 'self'`; `img-src 'self' blob: data:`; `media-src 'self' blob:`; no inline script), `Referrer-Policy: no-referrer`, `Permissions-Policy: microphone=(self), camera=()`, `X-Content-Type-Options: nosniff`.
- Secrets only in `.env`. Tokens and codes are stored hashed. Logs never contain tokens, codes or email bodies.
- Location data is stripped from every rendition. Originals are never served.
- Removing a person signs them out everywhere and deletes their passkeys and push subscriptions.

## Testing

- Server: `cd server && npm test` (`node --test`), with every test on a temp `DATA_DIR`/`MEDIA_DIR` and the `console` email transport (codes are captured by a test hook). Passkey tests use a software authenticator (`test/helpers/softAuthenticator.js`, ES256). Media tests skip the ffmpeg/heif cases when the binaries are missing (`npm test` inside the Docker image runs them all).
- Web: `cd web && npm test` for pure modules (time format, grouping, outbox state machine).
- End to end: `cd web && npm run e2e` starts the server on `127.0.0.1:8787` with temp dirs and drives Playwright 1.58's headless shell through invite → code → passkey (CDP virtual authenticator) → upload → the frame shows it → react → Grandma's Feed shows it.
