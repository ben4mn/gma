# Cloudflare Tunnel: gma.4mn.org

gma has its own named tunnel, like Ben's other apps on the box. The tunnel runs
in the `gma-tunnel` container inside gma's compose project and goes straight to
the app over the compose network. nginx-proxy-manager (80/443), the host's
`/etc/cloudflared` and every other app's tunnel are not involved.

```
phone ─ https ─ Cloudflare ─ tunnel c0773eb4… ─ gma-tunnel (10.35.0.3) ─ http://app:8080 (gma-app, 10.35.0.2)
```

| | |
|---|---|
| Tunnel | `gma`, id `c0773eb4-ed3d-42bf-aa5e-d6fe842ab67b` (already created) |
| Credentials | `/home/ben/.cloudflared/c0773eb4-ed3d-42bf-aa5e-d6fe842ab67b.json` (uid 1000, mode 0400); `.env` → `GMA_TUNNEL_CREDENTIALS` |
| Config | [`deploy/cloudflared.yml`](cloudflared.yml), mounted read-only at `/etc/cloudflared/config.yml` |
| Ingress | `gma.4mn.org` → `http://app:8080`; anything else → 404 |

The app believes `CF-Connecting-IP` (for rate limits) only from the tunnel's
address: compose sets `TRUST_PROXY=10.35.0.3`. If you ever change the tunnel's
`ipv4_address` in `docker-compose.yml`, change `TRUST_PROXY` with it.

## 1. Route the DNS name to the tunnel (once)

This makes **one new** proxied CNAME, `gma.4mn.org` → `c0773eb4-….cfargotunnel.com`.
Run it on the box as ben (it uses `~/.cloudflared/cert.pem`, which must belong
to the Cloudflare account that holds the 4mn.org zone):

```sh
cloudflared tunnel route dns gma gma.4mn.org
```

- If a `gma.4mn.org` record already exists, the command fails instead of
  overwriting it. Look at it in the dashboard before doing anything else; don't
  add `--overwrite-dns` unless you know that record is a leftover of gma's.
- Never edit other hostnames' routes or `/etc/cloudflared` for this: gma needs
  nothing outside its own compose project.

Check the record:

```sh
dig +short gma.4mn.org     # Cloudflare's addresses (the record is proxied), never the box's own IP
```

## 2. Start it

The tunnel container starts with the rest (`docker compose up -d --build`, see
the README) and waits for the app to be healthy first.

```sh
docker compose ps tunnel                 # Up
docker compose logs --tail 30 tunnel     # "Registered tunnel connection" ×4, no errors
cloudflared tunnel info gma              # on the host: 4 connections from this box
```

## 3. Zone settings for this hostname

The app sends a strict Content-Security-Policy, so anything Cloudflare injects
into pages would be blocked or break the page. For gma.4mn.org (Rules →
Configuration Rules, matching `http.host eq "gma.4mn.org"`):

- Rocket Loader and Email Address Obfuscation: off (both inject scripts).
- No Cache Rule that caches `/media/*` or `/api/*`. The app marks media
  `private`, so Cloudflare won't cache it by default; keep it that way.
- No Cloudflare Access in front of it: Grandma's frame and the installed phone
  apps can't do the Access login.

Limits worth knowing: a request body is capped at 100 MB (tus uploads use 32 MB
chunks), and an idle connection is closed after 100 s (the live-updates stream
sends a comment every 25 s).

## 4. Verify

```sh
curl -s  http://127.0.0.1:3064/healthz        # on the box: {"ok":true,"db":true,"worker_last_seen":…}
curl -sI https://gma.4mn.org/healthz          # HTTP/2 200, x-robots-tag: noindex, nofollow
curl -sI https://gma.4mn.org/                 # 302 to /signin?next=%2F
curl -sI https://gma.4mn.org/ | grep -i strict-transport-security
```

Then on a phone: open `https://gma.4mn.org/signin`, request a code (with
`EMAIL_TRANSPORT=console` it appears in `docker compose logs app`), and sign in.
Check Ben's other sites still load; nothing of theirs was touched.

If the tunnel flaps (repeated "Unregistered tunnel connection" in the logs),
add `protocol: http2` at the top level of `deploy/cloudflared.yml` and
`docker compose up -d tunnel`.

## Removing it

```sh
docker compose stop tunnel && docker compose rm -f tunnel   # gma is off the internet; the app keeps running
```

Then delete the `gma.4mn.org` CNAME in the Cloudflare dashboard (DNS → Records).
To drop the tunnel itself as well (only if gma is going away for good):

```sh
cloudflared tunnel cleanup gma
cloudflared tunnel delete gma
rm /home/ben/.cloudflared/c0773eb4-ed3d-42bf-aa5e-d6fe842ab67b.json
```

Nothing else on the box or in other tunnels changes.
