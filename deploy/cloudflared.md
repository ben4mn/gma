# Cloudflare Tunnel: adding gma.4mn.org

The homelab already runs a tunnel for Ben's other sites. gma.4mn.org is one more
public hostname on that same tunnel, pointing at nginx on the homelab. Nothing
else about the tunnel changes.

```
browser ─ https ─ Cloudflare ─ tunnel ─ cloudflared (homelab) ─ http://localhost:80 (nginx) ─ 127.0.0.1:8090 (app)
```

Before you start: the app is up (`curl -s http://127.0.0.1:8090/healthz` says
`"ok":true`) and the nginx site is enabled (`curl -s -H 'Host: gma.4mn.org' http://127.0.0.1/healthz`).

## 1. Find out how the tunnel is managed

```sh
systemctl cat cloudflared | grep ExecStart
```

- `--config /etc/cloudflared/config.yml` (or `~/.cloudflared/config.yml`): a
  **locally managed** tunnel. Follow step 2a.
- `tunnel run --token …`: a **dashboard-managed** tunnel. Follow step 2b.

## 2a. Locally managed: add one ingress rule

Edit the config file and add the gma rule **above** the final catch-all rule.
Leave every other rule exactly as it is; rules match top to bottom.

```yaml
ingress:
  # … existing rules stay as they are …
  - hostname: gma.4mn.org
    service: http://localhost:80
  # the catch-all must stay last
  - service: http_status:404
```

Check the file and which rule a URL will hit:

```sh
cloudflared tunnel ingress validate
cloudflared tunnel ingress rule https://gma.4mn.org/healthz   # should print the gma rule
```

Create the DNS record (a proxied CNAME to `<tunnel-id>.cfargotunnel.com`):

```sh
cloudflared tunnel list                                  # the tunnel's name or id
cloudflared tunnel route dns <tunnel-name-or-id> gma.4mn.org
```

`route dns` needs the 4mn.org zone in the Cloudflare account that
`~/.cloudflared/cert.pem` belongs to. If the record already exists, it fails
rather than overwriting it; check it in the dashboard.

Then restart the tunnel. Existing sites blip for a second or two:

```sh
sudo systemctl restart cloudflared
journalctl -u cloudflared -n 50 --no-pager   # "Registered tunnel connection" ×4, no errors
```

## 2b. Dashboard-managed

Zero Trust → Networks → Tunnels → the homelab tunnel → Public Hostname →
Add a public hostname: subdomain `gma`, domain `4mn.org`, type `HTTP`, URL
`localhost:80`. Saving creates the DNS record. No restart is needed.

## 3. Zone settings for this hostname

The app sends a strict Content-Security-Policy, so anything Cloudflare injects
into pages would be blocked (or break the page). For gma.4mn.org, make sure these
are off (Rules → Configuration Rules, matching `http.host eq "gma.4mn.org"`):

- Rocket Loader and Email Address Obfuscation: off (both inject scripts into pages).
- No Cache Rule that caches `/media/*` or `/api/*`. The app marks media
  `private`, so Cloudflare won't cache it by default; keep it that way.
- Don't put Cloudflare Access in front of it: Grandma's frame and the installed
  phone apps can't do the Access login.

Limits worth knowing: a request body is capped at 100 MB (tus uses 32 MB
chunks), and an idle connection is closed after 100 s (the live-updates stream
sends a comment every 25 s).

## 4. Verify

```sh
curl -sI https://gma.4mn.org/healthz          # HTTP/2 200, x-robots-tag: noindex, nofollow
curl -s  https://gma.4mn.org/healthz          # {"ok":true,"db":true,"worker_last_seen":…}
curl -sI https://gma.4mn.org/                 # 302 to /signin?next=%2F
curl -sI https://gma.4mn.org/ | grep -i strict-transport-security
```

Then on a phone: open `https://gma.4mn.org/signin`, request a code, and sign in.
Check Ben's other sites still load.

## Undo

Remove the rule (2a) or the public hostname (2b), restart cloudflared (2a only),
and delete the `gma` DNS record. Nothing else was touched.
