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
heif-dec, ffmpeg), one Docker image, running on Ben's homelab behind nginx and a
Cloudflare Tunnel. The frontend is plain JavaScript modules and CSS, with no build step.

```
server/   the app, the worker, the CLIs (server/scripts) and their tests
web/      the family PWA (index.html, app/) and Grandma's frame (grandma/)
deploy/   docker-compose.yml, the nginx site, the tunnel and backup runbooks
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

## Deploy (Ben's homelab)

1. Check out the repo on the server and `cp .env.example .env`. Fill in
   `SECRET_KEY` (`openssl rand -base64 48`), `RESEND_API_KEY`, `VAPID_SUBJECT`
   and a free `GMA_HOST_PORT`. Never commit `.env`.
2. Build and start the app and the worker:
   ```sh
   docker compose --env-file .env -f deploy/docker-compose.yml up -d --build
   ```
3. Web push keys, once and never again (rotating them cuts off every phone):
   ```sh
   docker compose --env-file .env -f deploy/docker-compose.yml run --rm --no-deps app node scripts/gen-vapid.js --subject mailto:you@example.com
   ```
   Put the lines in `.env`, then `up -d` again.
4. Make Ben the admin:
   `docker compose --env-file .env -f deploy/docker-compose.yml exec app npm run admin:create -- --name "Ben Lee" --email ben@…`
5. nginx: [`deploy/nginx/gma.4mn.org.conf`](deploy/nginx/gma.4mn.org.conf).
   The tunnel: [`deploy/cloudflared.md`](deploy/cloudflared.md).
6. Backups before the family arrives: [`deploy/backup.md`](deploy/backup.md).
7. Pair the frame in `/admin` → The frame (or `npm run device:pair`), and use the
   link in the kiosk setup: [`pi/README.md`](pi/README.md).

Updating: `git pull`, then the same `up -d --build`. Migrations run at start.
Logs: `docker compose -p gma logs -f app worker`. Health: `https://gma.4mn.org/healthz`,
and `/admin` → The frame shows the queue, failed jobs, free disk and when the frame
was last seen.
