// The nightly database snapshot (DECISIONS.md, 2026-10-22: storage and backups).
//
// At 03:15 in settings.timezone the worker copies the live database with
// SQLite's backup API to MEDIA_DIR/backups/gma-YYYY-MM-DD.sqlite, so the cloud
// copy of the media drive also holds a database that restores cleanly (a live
// SQLite file copied mid-write may not). The newest 7 are kept.
//
// Once a day: a worker that starts after 03:15 without today's snapshot makes
// it then. Never twice at once: a claim row in settings keeps a second worker
// out, and the runner never starts one while another is running. A failed
// snapshot is tried again after the claim lapses (30 minutes).

import { randomBytes } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import Database from 'better-sqlite3';
import { DEFAULT_SETTINGS, getSetting, setSetting } from '../lib/settings.js';
import { assertMediaMounted } from '../lib/storage.js';
import { clockInZone } from '../lib/time.js';

export const SNAPSHOT_TIME = '03:15';
export const SNAPSHOTS_KEPT = 7;
export const CLAIM_TTL_MS = 30 * 60 * 1000;
export const BACKUPS_DIR = 'backups';
const SNAPSHOT_NAME = /^gma-\d{4}-\d{2}-\d{2}\.sqlite$/;
const TEMP_NAME = /^\.gma-.*\.tmp-/;
const TEMP_MAX_AGE_MS = 24 * 60 * 60 * 1000;

// "YYYY-MM-DD" for `ms` in an IANA time zone.
export function localDate(ms, timeZone) {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' })
    .formatToParts(new Date(ms));
  const get = (type) => parts.find((p) => p.type === type).value;
  return `${get('year')}-${get('month')}-${get('day')}`;
}

function zoneOf(db) {
  const zone = getSetting(db, 'timezone', DEFAULT_SETTINGS.timezone);
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: zone });
    return zone;
  } catch {
    return DEFAULT_SETTINGS.timezone;
  }
}

export function snapshotFileName(day) {
  return `gma-${day}.sqlite`;
}

// The local day a snapshot is due for now, or null (before 03:15, or already made today).
export function dueDay(db, now = Date.now()) {
  const zone = zoneOf(db);
  if (clockInZone(now, zone) < SNAPSHOT_TIME) return null;
  const day = localDate(now, zone);
  return getSetting(db, 'last_snapshot', null)?.day === day ? null : day;
}

// Takes the day's claim, unless another worker holds a live one or already finished.
function claim(db, day, now) {
  return db
    .transaction(() => {
      const held = getSetting(db, 'snapshot_claim', null);
      if (held?.day === day && (held.done || now - held.at < CLAIM_TTL_MS)) return false;
      setSetting(db, 'snapshot_claim', { day, at: now, done: false });
      return true;
    })
    .immediate();
}

// Copies the live database to `dest` and makes the copy a single self-contained
// file (rollback journal, not WAL), checked before it is trusted.
async function writeCopy(db, dest) {
  await db.backup(dest);
  const copy = new Database(dest);
  try {
    copy.pragma('journal_mode = DELETE');
    const check = copy.pragma('quick_check', { simple: true });
    if (check !== 'ok') throw new Error(`The snapshot failed its check: ${check}`);
  } finally {
    copy.close();
  }
}

// Keeps the newest `keep` snapshots and clears temp files a crash left behind.
export async function pruneSnapshots(dir, { keep = SNAPSHOTS_KEPT, now = Date.now() } = {}) {
  const names = await fs.readdir(dir).catch((err) => (err.code === 'ENOENT' ? [] : Promise.reject(err)));
  const snapshots = names.filter((n) => SNAPSHOT_NAME.test(n)).sort().reverse();
  const removed = [];
  for (const name of snapshots.slice(keep)) {
    await fs.rm(path.join(dir, name), { force: true });
    removed.push(name);
  }
  for (const name of names.filter((n) => TEMP_NAME.test(n))) {
    const file = path.join(dir, name);
    const stat = await fs.stat(file).catch(() => null);
    if (stat && now - stat.mtimeMs > TEMP_MAX_AGE_MS) await fs.rm(file, { force: true });
  }
  return removed;
}

// Makes today's snapshot if it is due. → { day, file, bytes } when one was
// written, or null when there was nothing to do. Throws MediaNotMountedError,
// before claiming the day, when the drive's sentinel is gone (the drive came
// unplugged), so a snapshot never lands on the SSD under an empty mount point.
export async function snapshotIfDue({ db, config, log = null, now = Date.now(), force = false }) {
  const zone = zoneOf(db);
  const day = force ? localDate(now, zone) : dueDay(db, now);
  if (!day) return null;
  assertMediaMounted(config.mediaDir, config.mediaSentinel);
  if (!claim(db, day, now)) return null;

  const dir = path.join(config.mediaDir, BACKUPS_DIR);
  await fs.mkdir(dir, { recursive: true });
  const name = snapshotFileName(day);
  const finalPath = path.join(dir, name);
  const tempPath = path.join(dir, `.${name}.tmp-${process.pid}-${randomBytes(4).toString('hex')}`);
  try {
    await writeCopy(db, tempPath);
    await fs.rename(tempPath, finalPath);
  } catch (err) {
    await fs.rm(tempPath, { force: true });
    await fs.rm(`${tempPath}-journal`, { force: true });
    throw err;
  }

  const { size } = await fs.stat(finalPath);
  const record = { day, file: `${BACKUPS_DIR}/${name}`, bytes: size, at: Date.now() };
  db.transaction(() => {
    setSetting(db, 'last_snapshot_at', record.at);
    setSetting(db, 'last_snapshot', record);
    setSetting(db, 'snapshot_claim', { day, at: now, done: true });
  })();

  try {
    const removed = await pruneSnapshots(dir, { now });
    if (removed.length) log?.info?.(`Removed ${removed.length} old database snapshot(s)`);
  } catch (err) {
    log?.warn?.(`Could not tidy old database snapshots: ${err.message}`);
  }
  log?.info?.(`Database snapshot saved: ${record.file} (${size} bytes)`);
  return record;
}
