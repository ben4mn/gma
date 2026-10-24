// Shared steps for the item pipelines (image.js, video.js): writing a rendition
// atomically, marking the item ready or failed, and publishing the event.

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { publish } from '../lib/events.js';
import { JobError } from './errors.js';
import { immediate } from '../lib/tx.js';

export function loadItem(db, id) {
  return db.prepare('SELECT * FROM items WHERE id = ?').get(id) ?? null;
}

export function throwIfAborted(signal) {
  if (signal?.aborted) throw new JobError('Cancelled by shutdown');
}

// Runs `fn(dir)` with a private scratch directory that is always removed.
export async function withScratchDir(fn) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'gma-job-'));
  try {
    return await fn(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

// Writes one rendition: `produce(tempPath)` fills a temp file next to the
// final one (→ optional { width, height }), then it is renamed into place, so a
// reader never sees half a file. → the renditions row.
export async function writeRendition(storage, ownerId, spec, produce) {
  const key = storage.renditionKey(ownerId, spec.name, spec.ext);
  const finalPath = await storage.ensureDirFor(key);
  const tempPath = storage.tempPathFor(key);
  try {
    const info = (await produce(tempPath)) ?? {};
    const { size } = await fs.stat(tempPath);
    await fs.rename(tempPath, finalPath);
    return {
      name: spec.name,
      path: key,
      mime: spec.mime,
      width: info.width ?? null,
      height: info.height ?? null,
      bytes: size,
    };
  } catch (err) {
    await fs.rm(tempPath, { force: true });
    throw err;
  }
}

// Saves the renditions and makes the item ready. → true when the item went
// live just now (and item.ready was published). A hidden item stays hidden; an
// item deleted while it was processing gets its new files removed again.
export async function finishItem({ db, storage, log }, itemId, { width, height, durationMs = null }, renditions) {
  const now = Date.now();
  const outcome = immediate(db, () => {
    const item = db.prepare('SELECT id, user_id, kind, batch_id, status, ready_at FROM items WHERE id = ?').get(itemId);
    if (!item) return { gone: true };
    const upsert = db.prepare(
      `INSERT INTO renditions (item_id, name, path, mime, width, height, bytes)
       VALUES (@item_id, @name, @path, @mime, @width, @height, @bytes)
       ON CONFLICT (item_id, name) DO UPDATE SET path = excluded.path, mime = excluded.mime,
         width = excluded.width, height = excluded.height, bytes = excluded.bytes`,
    );
    for (const r of renditions) upsert.run({ item_id: itemId, ...r });
    const goesLive = item.status === 'processing' || item.status === 'failed';
    // ready_at versions the media URLs (?v=), so a re-run gets fresh ones.
    db.prepare(
      `UPDATE items SET width = ?, height = ?, duration_ms = ?, error = NULL, ready_at = ?, status = ? WHERE id = ?`,
    ).run(width ?? null, height ?? null, durationMs, now, goesLive ? 'ready' : item.status, itemId);
    if (goesLive) {
      publish(db, 'item.ready', { item_id: itemId, user_id: item.user_id, kind: item.kind, batch_id: item.batch_id });
    }
    return { goesLive };
  });

  if (outcome.gone) {
    log?.info?.(`Item ${itemId} was deleted while it was being processed; removing its renditions`);
    await storage.removeRenditions(itemId);
    return false;
  }
  return outcome.goesLive;
}

// The last attempt failed: the owner sees `message` on Mine.
export function markItemFailed({ db }, itemId, message) {
  const item = db.prepare('SELECT id, user_id, status FROM items WHERE id = ?').get(itemId);
  if (!item || item.status !== 'processing') return false;
  immediate(db, () => {
    db.prepare("UPDATE items SET status = 'failed', error = ? WHERE id = ?").run(message, itemId);
    publish(db, 'item.failed', { item_id: itemId, error: message }, `user:${item.user_id}`);
  });
  return true;
}
