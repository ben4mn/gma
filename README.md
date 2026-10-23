# gma.4mn.org

A private family window for Grandma. Around 40 relatives send photos, videos and
messages from their phones (an installed web app); Grandma sees one calm stream on
a touchscreen frame in her kitchen and answers with a tap or her voice. Nothing is
public: the family joins by invite, and the frame is paired once by Ben.

- **Why and what**: [VISION.md](VISION.md)
- **How it's built (the contract)**: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)
- **What was decided and why**: [docs/DECISIONS.md](docs/DECISIONS.md)
- **Design reference**: `design/heirloom/` (open `design/index.html`)

One Node app (Fastify 5, SQLite via better-sqlite3) plus a media worker (sharp,
heif-dec, ffmpeg), one Docker image, running on Ben's Debian box behind its own
Cloudflare Tunnel. The frontend is plain JavaScript modules and CSS, with no build step.

```
server/   the app, the worker, the CLIs (server/scripts) and their tests
web/      the family PWA (index.html, app/) and Grandma's frame (grandma/)
deploy/   the tunnel's config and runbooks (cloudflared.yml, cloudflared.md, backup.md)
docker-compose.yml, Dockerfile   the deployment (app, worker, tunnel)
pi/       the frame's kiosk setup (Raspberry Pi 4)
```

## Run it locally

Needs Node 22 or newer (24 LTS in production). ffmpeg and `heif-dec` are only
needed to process videos, voice notes and iPhone HEIC photos; without them those
jobs fail with a clear error and everything else works.

```sh
cd server
npm install
export NODE_ENV=development PORT=8787    # PUBLIC_URL defaults to http://localhost:8787

npm start                  # the app: http://localhost:8787
npm run worker             # in a second terminal: processes uploads into renditions
```

In development the data lives in `<repo>/data` and `<repo>/media` (both
git-ignored), and sign-in emails are printed to the app's terminal instead of
sent, so you can copy the code.

Something to look at:

```sh
npm run seed:demo -- --yes      # a demo family, sample photos, Grandma's reactions and a paired "Demo frame"
```

It prints the demo frame's link (open it to see Grandma's screen) and refuses to
run on a database with real people in it. Sign in as `admin@demo.invalid`, or make
yourself an admin:

```sh
npm run admin:create -- --name "Ben Lee" --email ben@example.com
npm run device:pair -- --name "Grandma's frame"     # prints the frame's pairing link once
npm run -s vapid:gen -- --subject mailto:ben@example.com   # web push keys, once, into .env
```

## Tests

```sh
cd server && npm test      # node --test with fastify.inject; temp dirs, no ports, no network
cd web && npm test         # the pure frontend modules
```

Media tests skip the ffmpeg and heif cases when those tools are missing; inside
the Docker image they all run.

## Deploy (Ben's Debian box)

gma lives in `/home/ben/gma`, like Ben's other apps: `docker-compose.yml` with
`.env` beside it. Three containers: `gma-app`, `gma-worker` and `gma-tunnel`
(gma's own Cloudflare tunnel, straight to the app; nginx-proxy-manager isn't
involved). The database is on the SSD (the `gma_data` volume); photos and videos
are on the Seagate drive at `/mnt/seagate/gma/media`. If the drive isn't
mounted, the app and the worker refuse to start rather than write photos to the SSD.

1. Get the code and make `.env`:
   ```sh
   cd /home/ben
   gh repo clone ben4mn/gma && cd gma
   cp .env.example .env && chmod 600 .env
   ```
   The first time only, with the drive mounted, make gma's media folder and the
   file that tells the app the drive is there (as ben, so uid 1000 owns them):
   ```sh
   mountpoint -q /mnt/seagate && mkdir -p /mnt/seagate/gma/media && touch /mnt/seagate/gma/media/.gma-media
   ls -lna /mnt/seagate/gma/media/.gma-media     # owner 1000; the app and the worker check for this file
   ```
   Fill in `.env`:
   - `SECRET_KEY`: `openssl rand -base64 48`
   - `VAPID_SUBJECT`: a real `mailto:` address
   - `EMAIL_TRANSPORT=console` until Resend is set up for auth.4mn.org: sign-in
     codes then appear in `docker compose logs app`. Afterwards set `resend`
     and `RESEND_API_KEY`.
   - `GMA_TUNNEL_CREDENTIALS` already holds the tunnel's credentials path.

   Never commit `.env`, and keep a copy of it in the password manager
   ([why](deploy/backup.md#what-is-not-backed-up-yet)).
2. Web push keys, once and never again (new keys cut off every phone):
   ```sh
   docker compose run --rm app npm run -s vapid:gen
   ```
   Paste the two `VAPID_…` lines into `.env`.
3. Build and start:
   ```sh
   docker compose up -d --build
   docker compose ps                                # app and worker "healthy", tunnel "Up"
   curl -s http://127.0.0.1:3064/healthz            # {"ok":true,"db":true,…}
   ```
4. Make Ben the admin:
   ```sh
   docker compose exec app npm run admin:create -- --name "Ben Lee" --email ben@…
   ```
5. Route the DNS name to the tunnel (once; it makes one new record and touches
   nothing else). Details, checks and removal: [`deploy/cloudflared.md`](deploy/cloudflared.md).
   ```sh
   cloudflared tunnel route dns gma gma.4mn.org
   ```
   Then sign in at `https://gma.4mn.org/signin` (the code is in `docker compose logs app`).
6. Pair the frame in `/admin` → The frame (or
   `docker compose exec app npm run device:pair -- --name "Grandma's frame"`), and
   put the link in the kiosk setup: [`pi/README.md`](pi/README.md).
7. Backups: the worker writes a database snapshot to the drive every night, so a
   cloud backup of the drive holds everything. What is and isn't covered, and how
   to restore: [`deploy/backup.md`](deploy/backup.md).

Updating:

```sh
cd /home/ben/gma && git pull && docker compose up -d --build
```

Migrations run when the app starts. Logs: `docker compose logs -f app worker`.
Health: `https://gma.4mn.org/healthz`, and `/admin` → The frame shows the queue,
failed jobs, free disk and when the frame was last seen.

If the drive isn't mounted, the app and the worker don't start: Docker can't
find `/mnt/seagate/gma/media` (`docker compose up` says so), or the app finds no
`.gma-media` file there and stops with a line saying so (`docker compose logs app`).
Docker doesn't retry by itself, so once the drive is back at `/mnt/seagate`, run
`docker compose up -d`.

The nginx site in `deploy/nginx/` is an optional note only; the tunnel doesn't use it.
