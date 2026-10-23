# Backups and the restore drill

What matters, in order: the **originals** (the photos and videos the family
sent; irreplaceable), the **database** (who sent what, Grandma's reactions and
messages, people, settings), then the renditions (re-creatable from the
originals, but slow). Three layers, all to an offsite bucket (Cloudflare R2 or
Backblaze B2; the target is still to be chosen, see `docs/DECISIONS.md`):

| What | How | How often | Lose at most |
|---|---|---|---|
| Database | Litestream 0.5 streams the SQLite WAL to the bucket | continuously | ~1 s |
| Database | `sqlite3 .backup` snapshot, kept with restic | nightly | a day (if Litestream broke) |
| Media | restic snapshots of `originals/` and `renditions/` | nightly | a day of uploads |

The volumes are `gma_gma-data` (`/data/gma.sqlite`) and `gma_gma-media`
(`/media/originals`, `/media/renditions`, `/media/uploads` = tus scratch, never
backed up). Find them on the host with:

```sh
docker volume inspect gma_gma-data  -f '{{ .Mountpoint }}'   # /var/lib/docker/volumes/gma_gma-data/_data
docker volume inspect gma_gma-media -f '{{ .Mountpoint }}'
```

Credentials go in `/etc/gma-backup.env` (root-only, `chmod 600`), never in git:

```sh
# R2: an API token with Object Read & Write on the one bucket
BACKUP_S3_ENDPOINT=https://<account-id>.r2.cloudflarestorage.com
BACKUP_BUCKET=gma-backups
AWS_ACCESS_KEY_ID=…
AWS_SECRET_ACCESS_KEY=…
RESTIC_REPOSITORY=s3:https://<account-id>.r2.cloudflarestorage.com/gma-backups/restic
RESTIC_PASSWORD_FILE=/etc/gma-restic.pass   # keep a copy in Ben's password manager: without it the backups are unreadable
```

For B2, use its S3 endpoint (`https://s3.<region>.backblazeb2.com`) and an
application key limited to the bucket.

## 1. Litestream (continuous database replication)

Run it as a sidecar next to the stack, sharing the data volume. Save as
`deploy/docker-compose.backup.yml` on the server and start both files together:

```yaml
services:
  litestream:
    image: litestream/litestream:0.5
    restart: unless-stopped
    command: ["replicate", "-config", "/etc/litestream.yml"]
    env_file: /etc/gma-backup.env
    volumes:
      - gma-data:/data
      - ./litestream.yml:/etc/litestream.yml:ro
    logging: { driver: json-file, options: { max-size: "10m", max-file: "3" } }
```

```yaml
# deploy/litestream.yml (Litestream expands ${VARS} from its environment)
dbs:
  - path: /data/gma.sqlite
    replica:
      type: s3
      endpoint: ${BACKUP_S3_ENDPOINT}
      bucket: ${BACKUP_BUCKET}
      path: litestream/gma
      region: auto
```

```sh
docker compose --env-file .env -f deploy/docker-compose.yml -f deploy/docker-compose.backup.yml up -d
docker compose -p gma logs litestream --tail 20    # no errors; it should mention the replica
```

Notes: the app and the worker keep SQLite's automatic checkpoints, which is
fine with Litestream; don't add manual `wal_checkpoint(TRUNCATE)` calls. Check
the config keys against `litestream version`'s docs when you install it: 0.5
changed the replica format (LTX) and replicas from 0.3 can't be restored by 0.5.

## 2. Nightly snapshot and media backup (restic)

Install on the host: `sudo apt install sqlite3 restic`. Initialise the
repository once: `sudo sh -c 'set -a; . /etc/gma-backup.env; restic init'`.

`/usr/local/sbin/gma-backup` (root, `chmod 700`):

```sh
#!/bin/sh
set -eu
. /etc/gma-backup.env
export AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY RESTIC_REPOSITORY RESTIC_PASSWORD_FILE

DATA=$(docker volume inspect gma_gma-data -f '{{ .Mountpoint }}')
MEDIA=$(docker volume inspect gma_gma-media -f '{{ .Mountpoint }}')
SNAP=/var/backups/gma
mkdir -p "$SNAP"

# A consistent copy while the app keeps running (.backup is SQLite's online backup).
sqlite3 "$DATA/gma.sqlite" ".backup '$SNAP/gma.sqlite'"
sqlite3 "$SNAP/gma.sqlite" 'PRAGMA integrity_check;' | grep -qx ok

restic backup --tag gma --host homelab "$SNAP/gma.sqlite" "$MEDIA/originals" "$MEDIA/renditions"
restic forget --tag gma --keep-daily 7 --keep-weekly 8 --keep-monthly 24 --prune
```

Cron (`/etc/cron.d/gma-backup`), after night falls on the frame:

```
30 3 * * * root /usr/local/sbin/gma-backup >> /var/log/gma-backup.log 2>&1
```

Once a month, also run `restic check --read-data-subset 5%`.

rclone works instead of restic if you'd rather keep plain files in the bucket
(`rclone sync "$MEDIA/originals" r2:gma-backups/originals`), but you lose
versioning: a deleted photo disappears from the bucket at the next sync.

## 3. Restore drill (every three months, and after any change to this setup)

Do it on a scratch directory, not over the live volumes.

```sh
GMA_REPO=/srv/gma            # where this repo is checked out on the server
mkdir -p /tmp/gma-drill && cd /tmp/gma-drill
set -a; . /etc/gma-backup.env; set +a

# 1. The database from Litestream (newest state), then from last night's snapshot.
docker run --rm --env-file /etc/gma-backup.env -v "$PWD":/out -v "$GMA_REPO/deploy/litestream.yml":/etc/litestream.yml:ro \
  litestream/litestream:0.5 restore -config /etc/litestream.yml -o /out/litestream.sqlite /data/gma.sqlite
restic restore latest --tag gma --target ./restic --include /var/backups/gma/gma.sqlite

for db in litestream.sqlite restic/var/backups/gma/gma.sqlite; do
  sqlite3 "$db" 'PRAGMA integrity_check;'                          # ok
  sqlite3 "$db" "SELECT COUNT(*) FROM users; SELECT COUNT(*) FROM items; SELECT MAX(created_at) FROM items;"
done

# 2. The media: restore a sample and compare with the database.
restic restore latest --tag gma --target ./restic --include originals
find restic -path '*originals*' -type f | wc -l   # ≈ SELECT COUNT(*) FROM items WHERE original_path IS NOT NULL
```

Note the date and the counts (Ben's notes are fine). Then delete
`/tmp/gma-drill`: it holds family photos.

### A real restore (the homelab died)

1. Set up the new host: Docker, this repo, the same `.env` (the `SECRET_KEY` and
   VAPID keys must be the old ones, or every session and push subscription breaks).
2. `docker compose --env-file .env -f deploy/docker-compose.yml create` makes the
   empty volumes without starting anything.
3. Restore the database into the data volume (Litestream for the newest state,
   or the nightly snapshot) as `gma.sqlite`; restore `originals/` and
   `renditions/` into the media volume. Then `chown -R 1000:1000` both (the
   image runs as `node`, uid 1000).
4. `docker compose … up -d`, check `/healthz`, sign in, and open `/admin` →
   The frame for the health line. Grandma's frame reconnects by itself (its
   pairing link is in the kiosk setup), so nothing changes at her end.
