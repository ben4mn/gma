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
  scripts/                # CLIs: create-admin.js, pair-device.js, gen-vapid.js, seed-demo.js; worker-health.js (the worker container's healthcheck); lib/cli.js
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
| `PUBLIC_URL` | (required in production) | origin used for links, the Origin check, WebAuthn's expected origin; `http://localhost:<PORT>` in development and test |
| `HOST` / `PORT` | `0.0.0.0` / `8080` | inside the container |
| `DATA_DIR` | `/data` | `gma.sqlite` lives here (`<repo>/data` in development and test) |
| `MEDIA_DIR` | `/media` | `originals/`, `renditions/`, `uploads/` (tus scratch); `<repo>/media` in development and test |
| `WEB_DIR` | `<repo>/web` | optional; where the static web app is served from |
| `SECRET_KEY` | (required in production) | ≥ 32 random bytes, base64; HMAC key for codes and token hashes; a fixed dev key in development and test |
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
| `TRUST_PROXY` | `true` in production, else `false` | behind nginx + cloudflared |
| `LOG_LEVEL` | `info` (`silent` in test) | |

`loadConfig(env)` (`server/src/config.js`) returns a frozen object whose keys are these names in camelCase (`publicUrl`, `secretKey`, `emailTransport`, `resendApiKey`, `emailFrom`, `vapidPublicKey`, `vapidPrivateKey`, `vapidSubject`, `webauthnRpId`, `webauthnRpName`, `maxUploadBytes`, `maxVideoSeconds`, `maxVoiceSeconds`, `trustProxy`, `logLevel`, `dataDir`, `mediaDir`, `webDir`, `host`, `port`, `nodeEnv`), plus `isProduction`, `publicOrigin`, `dbPath` (`<dataDir>/gma.sqlite`) and `cookieSecure` (true unless `PUBLIC_URL` is plain http outside production). It throws a `ConfigError` with a readable message for a missing or malformed value.

## Data model (SQLite, `server/src/db/migrations/001_init.sql`)

All ids are 26-char ULIDs (`lib/ids.js::newId()`) except passkey credential ids. All times are integers, milliseconds since the epoch, UTC. Booleans are 0/1.

```sql
users            (id PK, name, email UNIQUE COLLATE NOCASE, role 'admin'|'member', status 'pending'|'active'|'removed',
                  color, created_at, activated_at, removed_at)
invites          (id PK, token_hash UNIQUE, created_by → users NULL, name, email, role, sent_at /* when the app emailed it; NULL = shared another way */,
                  expires_at, used_at, used_by → users, revoked_at, created_at)
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
events           (id INTEGER PK AUTOINCREMENT, topic, audience 'all'|'devices'|'user:<id>'|'device:<id>', payload JSON, created_at)  -- SSE outbox
settings         (key PK, value JSON)   -- night_start '21:00', night_end '07:00', timezone 'America/Chicago', max_video_seconds …
admin_log        (id PK, user_id, action, target, detail JSON, created_at)
```

`devices.created_by` is NULL when the CLI paired the device. Media paths (`items.original_path`, `renditions.path`, `voice_notes.original_path`/`audio_path`) are storage *keys*, relative to `MEDIA_DIR` (see Server core). Seed rows in the migration: the 8 presets ("Love you", "Call me", "Thank you", "Miss you all", "So beautiful", "Made my day", "Come visit soon", "Proud of you") and the default settings.

## Sessions, auth and devices

- **Cookie** `gma_session`: random 32-byte token (base64url), only its SHA-256 is stored. `HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=34560000` (400 days, Chrome's cap). Each request touches `last_seen_at`; past half its life the expiry is pushed out (sliding). `lib/sessions.js` owns `createSession(db, {kind, userId|deviceId, userAgent})`, `setSessionCookie(reply, token)`, `clearSessionCookie(reply)`, `loadSession(db, token)`, `revokeUserSessions(db, userId)`, `revokeDeviceSessions(db, deviceId)`.
- **Guards** (`lib/guards.js`, Fastify preHandlers): `requireUser`, `requireAdmin`, `requireDevice`, `requireUserOrDevice`. They set `request.user` or `request.device`. Removed users and revoked devices are 401.
- **CSRF**: every state-changing request (`POST/PUT/PATCH/DELETE`) must carry an `Origin` header equal to `PUBLIC_URL`'s origin (tus requests included). JSON bodies only, no form posts, plus SameSite=Lax.
- **Invite** (admin-made, single use, 14 days): `/join/<token>`. If the app emailed the invite to that address, opening the link proves the email and signs them in straight away. If Ben shared the link some other way (a text), they type their name and email and confirm with a code. A user is `pending` until that first sign-in. Accepting marks the invite used by that pending person, but it stays usable until they finish signing in, so a mistyped email is fixed by opening the link again (the same pending person gets the new address). Typing the address of someone who already has an account only sends them a code and leaves the invite alone, unless the link proves that address. A removed person's address is refused. An invite never changes an existing person's role.
- **Email code** (the reliable path on iPhone, where the installed app has its own cookie jar): 6 digits, valid 15 min, 5 attempts, the newest code wins. Stored as an HMAC. The same email carries a link to `/confirm?t=<token>`. That page needs a button tap (a POST) to sign in, so mail scanners that open links can't burn it. Rate limits: 5 code requests per email per hour and 20 per IP per hour. `POST /api/auth/code/request` always answers 200, so it never reveals who has an account (the email is sent without waiting, so the timing doesn't tell either, and the per-email limit silently sends nothing). Other per-IP limits: code verify and link confirm 30 per 15 min, passkey login 30 a minute, invite lookups 60 a minute, invite accepts 20 an hour. The per-IP key is `CF-Connecting-IP` when `TRUST_PROXY` is on, else `request.ip`.
- **Passkeys** ("Use Face ID next time"): after the first sign-in (and after any code sign-in on a device without one, at most 3 offers), the app offers to create a passkey (discoverable credential, `residentKey: 'required'`, `userVerification: 'required'`, attestation `none`, RP ID `gma.4mn.org`). Later sign-ins use "Sign in with Face ID" (a usernameless `navigator.credentials.get`). The email code stays as the fallback and the recovery path. Verified rules (`docs/research/passkeys-research.json`): `create()`/`get()` run only from a tap, never on load; no conditional/autofill UI (it is unreliable in the installed iOS app); challenges are server-side, single use, 5 min; `requireUserVerification: true`; synced passkeys keep counter 0 (not a clone signal); one gentle error for every `NotAllowedError` ("That didn't work. Try again or get an email code."). The client fetches options before the tap (iOS loses a tap that waits on the network) but never while a ceremony is running: the server keeps one pending challenge per browser, so a second options call would replace the challenge the sheet is signing (`web/app/passkeys.js::prefetchOptions`; refresh only after a failure). iCloud Keychain must be on for iPhone passkeys; the code path covers everyone else. Grandma's frame never uses passkeys. A user can hold several passkeys and remove them on the You screen. Removing a user deletes their passkeys and sessions.
  - Implementation (`lib/webauthn.js`, `routes/auth.js`): the challenge is tied to the browser by the `gma_webauthn` cookie (HttpOnly, SameSite=Strict, path `/api/auth/passkey`, 5 min) holding the challenge row id plus an HMAC of it; the verify routes read the challenge from that row, never from the client, and delete it on first use. Registration also sets `authenticatorAttachment: 'platform'` (SimpleWebAuthn's `preferredAuthenticatorType: 'localDevice'`), so nobody lands on the security-key sheet; the user handle is an HMAC of the user id (stable, opaque); the label is the provider's name from the AAGUID ("Apple Passwords", "Google Password Manager", …, else "Passkey"). A sign-in's `userHandle`, when sent, must match. An unknown credential, or one whose owner was removed, is 404 `unknown_credential` (the client then calls `signalUnknownCredential` where supported and offers the email code).
  - The offer (`offer_passkey`, in the sign-in answers and `/api/me`): at most one offer per session and 3 per device, never on a device that signed in with or made a passkey. The count lives in the `gma_passkey_offers` cookie (HttpOnly, 400 days: `<count>.<session id last offered>` or `done`), so it survives a new session on the same phone; a passkey sign-in answers `offer_passkey: false`.
- **Grandma's frame**: Ben pairs a device in `/admin` (or `npm run device:pair`). That makes a 32-byte token, shown once as `https://gma.4mn.org/grandma?device=<token>`. `GET /grandma?device=` checks the token, creates a `device` session (cookie), and 302s to `/grandma/` with the token stripped from the URL. The kiosk launches with that URL, so a wiped browser profile pairs itself again at the next boot. Request logs redact the `device`, `t` and `token` query parameters.

## HTTP API

JSON in and out. Errors are `{error: {code, message}}`, and `message` is a sentence a person can read. Pagination is `?before=<id>&limit=` with ULID cursors.

| Area | Route | Guard | Notes |
|---|---|---|---|
| Health | `GET /healthz` | public | `{ok, db, worker_last_seen}` |
| Invites | `GET /api/invites/:token` | public | `{valid, name, email, emailed, reason}`; `reason` is `unknown`, `expired`, `revoked` or `used` when not valid; `emailed` = the app mailed it to `email` |
| | `POST /api/invites/:token/accept` `{name, email}` | public | creates/updates the pending user. Emailed to that address → signs in: `{signed_in: true, user, offer_passkey}`; otherwise sends a code: `{signed_in: false, email}`. Errors `invite_unknown` 404, `invite_expired`/`invite_revoked`/`invite_used` 410, `account_removed` 403 |
| Auth | `POST /api/auth/code/request` `{email}` | public | always 200 `{ok: true}` (a malformed email is 400 `invalid_email`; over 20 per IP per hour is 429) |
| | `POST /api/auth/code/verify` `{email, code}` | public | sets the session; `{user, offer_passkey}`. Every failure is the same 400 `invalid_code` |
| | `POST /api/auth/link/confirm` `{token}` | public | the `/confirm` page's button; `{user, offer_passkey}`, or 400 `link_expired` |
| | `POST /api/auth/passkey/register/options` / `…/verify` | user | options: the creation options JSON itself (for `startRegistration({optionsJSON})`); verify: body is `startRegistration`'s result → `{passkey, passkeys: n}` |
| | `POST /api/auth/passkey/login/options` / `…/verify` | public | usernameless; options: the request options JSON; verify: body is `startAuthentication`'s result → `{user, offer_passkey: false}`. 400 `passkey_failed`, 404 `unknown_credential` |
| | `POST /api/auth/logout` | user | `{ok: true}`; ends this session only |
| Me | `GET /api/me` | user | `{user, passkeys: n, push: bool, offer_passkey}`; `user` is `{id, name, email, role, status, color}` |
| | `GET /api/me/passkeys`, `DELETE /api/me/passkeys/:id` | user | list: `{passkeys: [{id, label, backed_up, device_type, created_at, last_used_at}], rp_id, user_handle}` (what `signalAllAcceptedCredentials` needs); delete: `{ok, passkeys: n}` |
| Items | `GET /api/items?scope=family\|mine&before=&limit=` | user | ready items (plus your own processing/failed on `mine`), renditions, Grandma's reactions per item. `{items, next_before}` (limit 30, max 100); each item is `{id, kind, status, caption, batch_id, created_at, ready_at, width, height, duration_ms, user: {id, name, color}, renditions: {<name>: {url, mime, width, height}}, grandma_events: [{id, kind, reaction, preset_text, recipient_user_id, created_at}], can_edit}` plus `error` on your own failed ones |
| | `GET /api/items/:id`, `PATCH /api/items/:id` `{caption}`, `DELETE /api/items/:id` | user (owner or admin) | `{item}`; `DELETE` → `{ok: true}` and `item.removed`. Captions ≤ 500 characters |
| Uploads | `ALL /api/uploads/*` (tus) | user | metadata `filename, filetype, caption, batch_id`; on finish → item `processing` + job. Only the uploader can continue an upload. The type is sniffed from the bytes (photo or video, else 415). The finishing response carries `X-Item-Id`; `Location` is relative. Unfinished chunks are swept after 7 days |
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

Admin details (`server/src/routes/admin.js`; every response `no-store`, every change an `admin_log` row, never a token):
- Invites: `{invite, url, sent}`, the link shown once. With `send`, the email goes out first; if it fails the answer is a 424 `email_failed` (a 4xx so the sentence reaches the form) and nothing is created. A new invite to an address revokes that address's older open invite. `GET /api/admin/people` → `{people, invites}` (open, unexpired invites only).
- Remove: also deletes pending login codes and WebAuthn challenges and revokes the person's open invites; an admin can't remove themselves. Restore → `active`, or `pending` if they never signed in.
- Items: only a `ready` item can be hidden (409 otherwise). Hide publishes `item.removed`, unhide `item.ready`, delete `item.removed`, each with `{item_id}`. Delete removes the original, the renditions, voice notes on the item and its jobs; Grandma's events on it stay (`item_id` → NULL).
- Devices: `POST` → `{device, url}`; reload publishes `frame.reload` to `device:<id>` (409 if unpaired).
- Presets: `PUT {presets: [{id?, text, active?}]}` is the whole list in order; 1 to 8 active, ≤ 40 characters each. Presets left out are deleted, or turned off if Grandma ever sent them. Publishes `settings.changed` `{keys: ['presets']}`.
- Settings: `night_start`, `night_end` (`HH:MM`), `timezone` (IANA), `max_video_seconds` (10–600), `max_voice_seconds` (10–60); anything else is a 400. Publishes `settings.changed` `{keys}`.
- Health: `{queue_depth, running, queue: {image, video, voice}, failed_jobs, recent_failures, items, disk_free_bytes, disk_total_bytes, frame_last_seen, frames, worker_last_seen}`.

Pages (all serve the family shell `web/index.html` unless noted): `/` Family, `/from-grandma` Grandma's Feed, `/mine`, `/upload`, `/join/:token`, `/signin`, `/confirm`, `/you`, `/admin`, `/admin/*`; `/grandma/` serves `web/grandma/index.html`.

## Live events (SSE)

The `events` table is an outbox. Anything that changes state (the app or the worker) inserts a row (`lib/events.js::publish(db, topic, payload, audience = 'all')`, which returns the row id). Audiences: `all` (every user and device), `devices` (frames), `user:<id>`, `device:<id>` (one frame, e.g. `frame.reload` from the admin's Reload button). The app polls it every second and fans new rows out to connected clients that match the audience. Event ids are the row ids, so `Last-Event-ID` resumes after a reconnect. Topics: `item.ready`, `item.removed`, `item.failed` (owner only), `grandma.event`, `settings.changed`, `frame.reload` (devices). Rows older than 7 days are deleted.

On the wire each event is `id: <row id>`, `event: <topic>`, `data: <payload JSON>`, so clients listen with `source.addEventListener('item.ready', …)` (`onmessage` sees nothing). The stream opens with `retry: 3000`. If a reconnecting client missed more than 500 events, or some were already pruned, it gets one `resync` event (`data: {}`) instead and should reload its state.

## Media pipeline (worker)

`jobs` is claimed with `UPDATE … SET status='running', locked_at=?, locked_by=? WHERE id = (SELECT id FROM jobs WHERE status='queued' AND run_after<=? ORDER BY created_at LIMIT 1) RETURNING *`. Concurrency: video 1, image 2, voice 1. Retries back off exponentially (30 s, 2 min, 10 min), with 3 attempts. At boot, `running` jobs locked more than 30 minutes ago are requeued. Jobs are idempotent: each writes to a temp path and renames into place. The worker writes `worker_last_seen` to settings every 15 s. A permanent failure (a video over the limit, an unreadable photo) skips the retries. When the last attempt fails, the item becomes `failed` with a kind sentence in `items.error` and `item.failed` `{item_id, error}` goes to `user:<owner>`; `item.ready` is `{item_id, user_id, kind, batch_id}` to `all`; the voice job's `grandma.event` is `{id, kind: 'voice', voice_note_id, item_id}`. The video limit is the lower of `MAX_VIDEO_SECONDS` and the `max_video_seconds` setting. On SIGTERM the runner lets running jobs finish for 20 s, then cancels them and requeues them without spending an attempt.

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

## Server core (the shared pieces feature routes build on)

- **`buildApp(config, { db?, routesDir?, routeOptions?, plugins? })`** opens the database (unless `db` is passed), decorates `app.config`, `app.db`, `app.storage` (`createStorage(config.mediaDir)`), `app.events` (the SSE hub) and `request.user` / `request.device` / `request.session` (null until a guard or `authenticate` runs), then registers every `src/routes/*.js` in name order with opts `{ config, db }` (each file is its own encapsulated plugin) and calls `ready()`.
- **Errors**: throw `httpError(status, code, message)` (from `lib/guards.js`), or any error with `statusCode` and a snake_case `code`; the handler sends `{error: {code, message}}`. 5xx bodies are always the generic sentence (the real error is logged). Unknown routes are a JSON 404.
- **Bodies**: JSON only; the `text/plain` parser is removed. A route plugin that needs another body type registers it *inside its own plugin*: the uploads plugin adds `application/offset+octet-stream` for tus, the frame plugin registers `@fastify/multipart` for `POST /api/frame/voice` (it is not registered globally).
- **Rate limits** are opt-in per route: `{ config: { rateLimit: { max, timeWindow, keyGenerator? } } }`; a 429 is `{error: {code: 'rate_limited', …}}`.
- **Guards** (`lib/guards.js`): `requireUser`, `requireAdmin` (401 signed out, 403 member), `requireDevice`, `requireUserOrDevice`, plus `authenticate(request, reply)` for routes that want the session without requiring one. A guard re-sets the cookie when the session slid.
- **Sessions** (`lib/sessions.js`): `createSession(db, {kind, userId|deviceId, userAgent})` → `{token, id, expiresAt}`; `loadSession(db, token)` → `{session, user, device, renewed}` or null (touches `last_seen_at`, and the device's, at most once a minute); `setSessionCookie(reply, token)`, `clearSessionCookie(reply)`, `readSessionToken(request)`, `destroySession(db, token)` (logout), `revokeUserSessions(db, userId)`, `revokeDeviceSessions(db, deviceId)`, `SESSION_COOKIE`.
- **Tokens** (`lib/tokens.js`): `randomToken(bytes = 32)` (base64url), `randomDigits(6)`, `sha256(value)` (hex, for tokens), `hmac(config.secretKey, value)` (hex, for codes), `safeEqual(a, b)`. **Ids**: `newId()`, `isId()`, `idTime()`. **Time**: `now()`, `setClock()` (tests), `SECOND`…`DAY`, `clockInZone(ms, tz)`, `inWindow(hhmm, start, end)`, `isNight(ms, settings)`, `isValidClockTime()`.
- **Settings** (`lib/settings.js`): `getSetting(db, key, fallback?)`, `setSetting(db, key, value)`, `getSettings(db, keys?)` (defaults filled in), `setSettings(db, object)`, `DEFAULT_SETTINGS`.
- **Email** (`lib/email.js`): `sendEmail(config, {to, subject, text, html})`, `signInCodeEmail({name, code, confirmUrl})`, `inviteEmail({name, inviterName, joinUrl})`, `escapeHtml()`; `captureEmails(config)` returns the array that receives that config's mail instead of sending it (the test hook).
- **Storage** (`lib/storage.js`): `createStorage(mediaDir)` → `{init(), originalKey(id, ext, createdAt), renditionKey(id, name, ext), resolve(key), ensureDirFor(key), tempPathFor(key), remove(key), removeRenditions(id), originalsDir, renditionsDir, uploadsDir}`; `safeJoin(root, …parts)`. Keys look like `originals/2026/10/<id>.heic` and `renditions/<id>/display.jpg`; a voice note's audio is `renditions/<voiceId>/audio.m4a`. `resolve` throws `UnsafePathError` on traversal.
- **Redaction** (`lib/redact.js`): `redactUrl(url)` (request logs; `device`, `t`, `token`, `code`), `stripSecretParams(url)` (redirect targets).
- **Pages**: a signed-out visit to a private page 302s to `/signin?next=<path>` (secret parameters stripped); `/admin*` sends members to `/`; `/grandma/` needs a device session or an admin. The shell is identical on every family path, so the family service worker precaches it from the public `/signin`. Caching: `/assets/*` one year immutable (rename a file to change it), `/vendor/*` 30 days, everything else (HTML, JS, CSS, service workers, the manifest) `no-cache` with ETags.
- **Worker**: `src/worker.js` opens the database, writes `worker_last_seen` every 15 s itself, and calls `startRunner({config, db, storage, log})` exported by `src/jobs/runner.js`, which returns `{stop()}` (awaited on SIGTERM). Without that file it logs and exits 1.

## Security and privacy

- Nothing public: every page except `/join`, `/signin`, `/confirm`, `/grandma?device=` and `/healthz` needs a session. Every response carries `X-Robots-Tag: noindex, nofollow`; `robots.txt` disallows all.
- Headers: a strict CSP (`default-src 'self'`; `img-src 'self' blob: data:`; `media-src 'self' blob:`; no inline script and no inline style either: no `<style>` blocks or `style="…"` attributes in HTML, set `element.style` from JS instead; `frame-ancestors 'none'`), `X-Frame-Options: DENY`, `Cross-Origin-Opener-Policy: same-origin`, HSTS when `PUBLIC_URL` is https, `Referrer-Policy: no-referrer`, `Permissions-Policy: microphone=(self), camera=()`, `X-Content-Type-Options: nosniff`.
- Secrets only in `.env`. Tokens and codes are stored hashed. Logs never contain tokens, codes or email bodies.
- Location data is stripped from every rendition. Originals are never served.
- Removing a person signs them out everywhere and deletes their passkeys and push subscriptions.

## Testing

- Server: `cd server && npm test` (`node --test "test/**/*.test.js"`; Node 22+ no longer takes a bare directory), with every test on a temp `DATA_DIR`/`MEDIA_DIR` and the `console` email transport (codes are captured by a test hook). `test/helpers/index.js`: `makeTestApp({env, routeOptions, plugins})` → `{app, db, config, mail, tempDir, cleanup}`, `makeUser(db, overrides)`, `makeDevice(db, overrides)` (the row plus its pairing `token`), `loginAs(app, db, user)` / `loginAsDevice(app, db, device)` → a `cookie` header value, `sameOrigin(cookie)` → headers with the app's Origin, `makeWebFixture(dir)`. Injected requests may omit `Origin` in test mode only; a real socket never may. Passkey tests use a software authenticator (`test/helpers/softAuthenticator.js`, ES256). Media tests skip the ffmpeg/heif cases when the binaries are missing (`npm test` inside the Docker image runs them all).
- Web: `cd web && npm test` for pure modules (time format, grouping, outbox state machine).
- End to end: `cd web && npm run e2e` (`web/e2e/run.sh`, `@playwright/test` 1.58.0 exactly) seeds the demo family into temp dirs under `/tmp/gma-e2e-*`, adds an admin, pairs a frame, starts the app and the worker on `127.0.0.1:8787` (`PUBLIC_URL=http://localhost:8787`: WebAuthn refuses an IP address as the RP ID), runs the specs with Playwright's bundled headless shell (never Google Chrome) and stops both. Sign-in codes are read from the app log (the `console` transport). `flow.spec.js`: invite → join with a code → passkey (CDP virtual authenticator, ctap2/internal/UV) → sign out → passkey sign-in → tus upload → ready → the frame's "New for you" → Love and a preset → Grandma's Feed and Mine → an offline reaction delivered exactly once. `grandma-audit.spec.js`: the `design/tools/shoot.py` checks on the real Grandma screens (targets ≥ 80 px, text ≥ 22 px, contrast ≥ 7:1 or 4.5:1 large, no scroll, a visible `[data-home]`, no autoplay, no request off the origin) and the family tabs (44 px, 13 px, 4.5:1), with screenshots of every state in `web/e2e/shots/`. Night hours are moved through `PUT /api/admin/settings` so the result doesn't depend on the time of day.
