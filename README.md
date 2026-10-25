# gma.4mn.org

> **Claude, start here.** If someone asked you to "follow the instructions for Claude" on this page, you're almost certainly helping **Ben's dad**. He's new to git and to building with Claude and has no GitHub account. Coach him patiently, one step at a time, and do the technical work yourself.
>
> 1. **First**, read [docs/helping/.hello](https://raw.githubusercontent.com/ben4mn/gma/draft/mvp/docs/helping/.hello) and do what it says.
> 2. **If you can't run commands on his computer** (you're in a browser, the Chat tab or the phone app): tell him this work happens in the **Code** tab of the Claude **desktop app**. Walk him there one step at a time: install the app from claude.ai/download if he doesn't have it, open it, click **Code** at the top, then type the same message again there.
> 3. **If you can run commands**: read [docs/helping/START-HERE.md](https://raw.githubusercontent.com/ben4mn/gma/draft/mvp/docs/helping/START-HERE.md) in full and follow it. It covers installing git, getting this code onto his computer, and sending his work back to Ben without GitHub.
>
> The code lives on the [`draft/mvp`](https://github.com/ben4mn/gma/tree/draft/mvp) branch.

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
deploy/   the tunnel's config and runbooks (cloudflared.yml, cloudflared.md, backup.md),
          and the server CI (ci-on-server.sh, ci/)
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
cd web && npm run e2e      # Playwright (headless shell) against the real app and worker on 127.0.0.1:8787
```

Media tests skip the ffmpeg and heif cases when those tools are missing. To run
everything in the real image, with ffmpeg and heif-dec present, use the server CI
from a Mac checkout:

```sh
bash deploy/ci-on-server.sh --dry-run   # what it would run on Ben's Debian box
bash deploy/ci-on-server.sh             # build gma:ci, the server suite inside it (no test may skip), the media smoke test
```

It works only under `/home/ben/gma-ci` with throwaway `gma-ci` containers, network
and volumes, publishes no ports, uses no sudo, and cleans up after itself. The smoke
test times every job, including a 5-second 4K HDR clip (about 16 s at the worker's
3 CPUs).

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
   - Leave `EMAIL_TRANSPORT=console` for now: sign-in codes appear in
     `docker compose logs app` until step 6 switches email to Gmail.
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
   curl -s http://127.0.0.1:3064/healthz            # {"ok":true,"db":true,"media":true,…}
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
6. Send email from Gmail, before inviting anyone. Ben runs this himself, so the
   app password never leaves the box. Give it another project's `.env` that
   already sends through Gmail (it reads the file, never runs it, and prints
   only which key names it used), or no path to type the address and the app
   password ([make one](https://myaccount.google.com/apppasswords) if needed):
   ```sh
   cd /home/ben/gma && bash deploy/use-gmail.sh --find     # which .env files in ~ hold one (key names only)
   bash deploy/use-gmail.sh /path/to/another/project/.env
   ```
   It checks the image can send through SMTP (if not, it says to run
   `git pull && docker compose up -d --build` first and changes nothing),
   saves `.env` as `.env.bak-<date>`, writes `EMAIL_TRANSPORT=smtp`, `SMTP_HOST`,
   `SMTP_PORT`, `SMTP_SECURE`, `SMTP_USER`, `SMTP_PASS` and `EMAIL_FROM` (both
   files 0600; a password with a `'` in it or ending in `\` is refused, since
   `.env` can't hold it safely),
   restarts gma, waits for it to be healthy and offers to send a test email.
   Test again any time:
   ```sh
   docker compose exec -T app npm run -s email:test -- --to you@example.com   # prints "sent" or the error
   ```
   Undo: `cp .env.bak-<date> .env && docker compose up -d`. Mail comes from
   `"Grandma's family" <your Gmail address>` (Gmail sends from the account
   whatever `EMAIL_FROM` says, unless it's a verified "Send mail as" alias) and
   Gmail allows about 500 a day, far more than a family needs.
7. Pair the frame in `/admin` → The frame (or
   `docker compose exec app npm run device:pair -- --name "Grandma's frame"`), and
   put the link in the kiosk setup: [`pi/README.md`](pi/README.md).
8. Backups: the worker writes a database snapshot to the drive every night, so a
   cloud backup of the drive holds everything. What is and isn't covered, and how
   to restore: [`deploy/backup.md`](deploy/backup.md).

Updating:

```sh
cd /home/ben/gma && git pull && docker compose up -d --build
```

Migrations run when the app starts. Before an upgrade migrates the database, the
app copies it to `/mnt/seagate/gma/media/backups/pre-<migration>-<time>.sqlite`
(and refuses to start if it can't), so a bad migration can be undone; delete old
copies by hand. Logs: `docker compose logs -f app worker`.
Health: `https://gma.4mn.org/healthz` (503 with `"media":false` if the drive drops
while running), and `/admin` → The frame shows the queue, failed jobs, free disk,
the upload limits and when the frame was last seen.

If the drive isn't mounted, the app and the worker don't start: Docker can't
find `/mnt/seagate/gma/media` (`docker compose up` says so), or the app finds no
`.gma-media` file there and stops with a line saying so (`docker compose logs app`).
Docker doesn't retry by itself, so once the drive is back at `/mnt/seagate`, run
`docker compose up -d`.

If the drive drops while gma is running, the app reports unhealthy and the worker
stops taking jobs (nothing queued is lost). Once the drive is mounted again, run
`docker compose down && docker compose up -d`: the containers keep the dead mount
until they are recreated. Details: [`deploy/backup.md`](deploy/backup.md).

The nginx site in `deploy/nginx/` is an optional note only; the tunnel doesn't use it.
