# Backups and restoring

Ben's plan (2026-10-22, see `docs/DECISIONS.md`): **no extra copies on local
disks.** Everything gma needs lives on the Seagate drive, and Ben will add a
daily cloud backup of that whole drive, on the assumption that it will fail
someday. So the one job here is to make sure the drive really does hold
everything, in a form that restores.

## What is where

| What | Where on the box | In a backup of the drive? |
|---|---|---|
| Originals (the photos and videos the family sent; irreplaceable) | `/mnt/seagate/gma/media/originals/` | yes |
| Renditions (what phones and the frame show; re-creatable, slowly) | `/mnt/seagate/gma/media/renditions/` | yes |
| **Nightly database snapshots** | `/mnt/seagate/gma/media/backups/gma-YYYY-MM-DD.sqlite` | yes |
| Live database (people, who sent what, Grandma's reactions and messages, settings) | the `gma_data` volume on the SSD (`/data/gma.sqlite` in the containers) | no: its snapshot is |
| Upload scratch (half-finished uploads) | `/mnt/seagate/gma/media/uploads/` | yes, but not needed |
| `.env` (the secret key and the push keys) | `/home/ben/gma/.env` | **no**, see below |

The database stays on the SSD because SQLite waits for the disk on every save
(an fsync), and the Seagate takes about 164 ms for one. Instead, at **03:15**
(in the timezone set in `/admin`) the worker copies the live database with
SQLite's backup API to `backups/gma-YYYY-MM-DD.sqlite` on the drive, checks the
copy, and keeps the newest 7. A worker that starts after 03:15 without that
day's snapshot makes it then. Copying the live `gma.sqlite` file directly
isn't safe (a copy taken mid-write may not open); the snapshot is.

So a backup of the drive taken after 03:15 holds the photos, the videos and a
database at most a day old.

Check that snapshots are being made:

```sh
ls -l /mnt/seagate/gma/media/backups/      # one file per night, the newest from today (after 03:15)
```

## What is NOT backed up yet

- **Everything, until Ben's cloud backup of the drive exists.** Until then a
  dead or lost Seagate means the photos, the videos and the snapshots are gone;
  the live database on the SSD survives, but it only points at missing files.
  This is accepted for the draft, which holds no real family data. The drive's
  SMART health is unknown (`smartctl` isn't installed).
- **`.env`.** `SECRET_KEY` and the VAPID keys must be the old ones after a
  restore, or every family member is signed out and every phone stops getting
  notifications. Keep a copy of `.env` in Ben's password manager (not on the
  drive: the drive's backup shouldn't hold the keys to everything).
- **Up to a day of activity** between the last snapshot and a failure of the
  SSD: reactions, messages, new people and settings from that day. Photos sent
  that day are on the drive, but the restored database won't list them.
- The tunnel's credentials (`/home/ben/.cloudflared/c0773eb4-….json`). If lost,
  make a new tunnel and update `.env` and `deploy/cloudflared.yml`.

When Ben sets up the cloud backup, it should include `/mnt/seagate/gma/media/`
(all of it, or at least `originals/`, `renditions/` and `backups/`; `uploads/`
can be skipped), and it is worth checking once that a restored snapshot opens
(below).

## The copy taken before an upgrade

When a new version brings database migrations, the app and the worker first copy the database with SQLite's backup API to `/mnt/seagate/gma/media/backups/pre-<migration>-<UTC time>.sqlite` (one per migration), then upgrade it. These are never pruned. If an upgrade turns out wrong, restore that file the same way as a nightly snapshot below, and roll back the code: nothing written since the deploy is lost.

## If the photo drive drops while gma is running

If the Seagate drive resets or is unplugged, its `.gma-media` file disappears from the containers' view. Then:

- `GET /healthz` answers 503 with `"media": false`, the worker's health check fails, and `docker compose ps` shows both as unhealthy. `/admin` health shows `media_mounted: false`.
- The worker stops taking jobs (it logs once) and nothing is marked failed; uploads and Grandma's voice notes are refused with a 500, which the phones and the frame retry.

Once the drive is mounted again on the host, recreate the containers so they see the new mount (a container keeps the dead one):

```sh
cd /home/ben/gma && docker compose down && docker compose up -d
```

The waiting jobs then carry on by themselves.

## Restoring the database from a snapshot

Use this when the database on the SSD is lost or damaged, or to go back to a
night before a mistake. Grandma's frame and the phones reconnect by themselves
afterwards.

```sh
cd /home/ben/gma
ls -l /mnt/seagate/gma/media/backups/                  # pick a snapshot
SNAP=gma-2026-10-21.sqlite                             # the one you picked

# 1. Stop gma (the app, the worker and the tunnel).
docker compose stop

# 2. Check the snapshot opens and looks right.
docker compose run --rm --no-deps app node -e "
  const db = require('better-sqlite3')('/media/backups/$SNAP', { readonly: true });
  console.log(db.pragma('integrity_check', { simple: true }));                   // ok
  console.log(db.prepare('SELECT COUNT(*) AS people FROM users').get());
  console.log(db.prepare('SELECT COUNT(*) AS items, MAX(created_at) AS newest FROM items').get());
"

# 3. Put it in the gma_data volume as gma.sqlite. The old file and its -wal/-shm
#    files are moved aside first: a leftover -wal from the old database must
#    never meet the restored one.
docker compose run --rm --no-deps app sh -c "
  set -e
  mkdir -p /data/before-restore
  for f in gma.sqlite gma.sqlite-wal gma.sqlite-shm; do
    if [ -e /data/\$f ]; then mv /data/\$f /data/before-restore/; fi
  done
  cp /media/backups/$SNAP /data/gma.sqlite
"

# 4. Start gma again.
docker compose up -d
docker compose ps                                      # app and worker healthy
curl -s http://127.0.0.1:3064/healthz                  # {"ok":true,…}
```

Then sign in and open `/admin` → The frame for the health line. Once you're
happy, delete the old copy (it's on the SSD and holds family data):

```sh
docker compose run --rm --no-deps app rm -rf /data/before-restore
```

Photos sent after that snapshot are still on the drive but not in the restored
database. They don't show anywhere; they can be found by date under
`originals/` if someone needs one back.

## Restoring everything on a new box

1. Mount the replacement drive at `/mnt/seagate` and restore the cloud backup
   into `/mnt/seagate/gma/media/` (it must contain `.gma-media`; the app won't
   start without it). Owner: `sudo chown -R 1000:1000 /mnt/seagate/gma/media`
   if the restore didn't keep it.
2. `gh repo clone ben4mn/gma /home/ben/gma`, and put the old `.env` back (same
   `SECRET_KEY` and VAPID keys). The tunnel's credentials go back in
   `/home/ben/.cloudflared/`.
3. `docker compose up -d --build`, which makes an empty `gma_data` and a new
   database, then follow "Restoring the database from a snapshot" above with the
   newest snapshot.

## Optional: continuous database replication (Litestream)

Not part of the plan. If losing up to a day of reactions and messages ever
matters, Litestream 0.5 can stream the database's changes to a bucket (R2 or
B2) every second, as a sidecar sharing the `gma_data` volume. That adds an
offsite target and its credentials to look after; the nightly snapshot on the
drive stays either way.
