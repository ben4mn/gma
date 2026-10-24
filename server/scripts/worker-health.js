#!/usr/bin/env node
// The worker container's healthcheck: healthy when the photo drive is still
// there (MEDIA_DIR/MEDIA_SENTINEL, as the container sees it) and the worker
// wrote worker_last_seen in the last minute (it writes it every 15 s).
//
//   node scripts/worker-health.js    exit 0 healthy, 1 not

import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { EXIT, runIfMain } from './lib/cli.js';

export const STALE_AFTER_MS = 60_000;

// The sentinel the worker checks, read the way config.js reads it: on by
// default in production, "off" turns it off.
export function sentinelPath(env) {
  const production = (env.NODE_ENV || 'production') === 'production';
  const raw = env.MEDIA_SENTINEL === undefined || env.MEDIA_SENTINEL === '' ? (production ? '.gma-media' : '') : String(env.MEDIA_SENTINEL).trim();
  if (!raw || /^(off|none|false|0)$/i.test(raw)) return null;
  return path.join(env.MEDIA_DIR || (production ? '/media' : 'media'), raw);
}

export async function main(argv, { env = process.env, out = console, now = Date.now() } = {}) {
  const sentinel = sentinelPath(env);
  if (sentinel && !fs.existsSync(sentinel)) {
    out.error(`The photo drive is gone: ${sentinel} is missing. Jobs wait until it is back.`);
    return EXIT.FAIL;
  }
  const dbPath = path.join(env.DATA_DIR || '/data', 'gma.sqlite');
  let db;
  try {
    db = new Database(dbPath, { readonly: true, fileMustExist: true });
    const row = db.prepare("SELECT value FROM settings WHERE key = 'worker_last_seen'").get();
    const lastSeen = row ? Number(JSON.parse(row.value)) : NaN;
    if (Number.isFinite(lastSeen) && now - lastSeen < STALE_AFTER_MS) return EXIT.OK;
    out.error(Number.isFinite(lastSeen) ? `The worker was last seen ${Math.round((now - lastSeen) / 1000)} s ago.` : 'The worker has not checked in yet.');
    return EXIT.FAIL;
  } catch (err) {
    out.error(`Could not read ${dbPath}: ${err.message}`);
    return EXIT.FAIL;
  } finally {
    db?.close();
  }
}

await runIfMain(import.meta.url, main, 'Usage: node scripts/worker-health.js');
