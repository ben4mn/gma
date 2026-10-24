// The family's photos and videos.
//
//   GET    /api/items?scope=family|mine&before=<id>&limit=   ready items, newest first
//                                                            (mine adds your own processing/failed ones)
//   GET    /api/items/:id
//   PATCH  /api/items/:id {caption}                          owner or admin
//   DELETE /api/items/:id                                    owner or admin; removes the files too
//
// Each item carries its renditions (versioned /media URLs), its sender and
// Grandma's reactions and messages about it. serializeItems() and removeItem()
// are exported for reuse; canView/canEdit live in lib/item-access.js.

import { publish } from '../lib/events.js';
import { httpError, requireUser } from '../lib/guards.js';
import { isId } from '../lib/ids.js';
import { canEdit, canView } from '../lib/item-access.js';
import { shortNameOf } from '../lib/people.js';
import { cancelQueued } from '../jobs/queue.js';
import { immediate } from '../lib/tx.js';

export const PAGE_DEFAULT = 30;
export const PAGE_MAX = 100;
export const CAPTION_MAX = 500;

const NOT_FOUND = () => httpError(404, 'not_found', "We couldn't find that photo. It may have been removed.");

export function mediaUrl(item, name) {
  return `/media/${item.id}/${name}?v=${item.ready_at ?? 0}`;
}

function placeholders(list) {
  return list.map(() => '?').join(', ');
}

function renditionsByItem(db, ids) {
  const map = new Map();
  if (!ids.length) return map;
  const rows = db
    .prepare(`SELECT item_id, name, mime, width, height FROM renditions WHERE item_id IN (${placeholders(ids)})`)
    .all(...ids);
  for (const row of rows) {
    if (!map.has(row.item_id)) map.set(row.item_id, []);
    map.get(row.item_id).push(row);
  }
  return map;
}

function grandmaEventsByItem(db, ids) {
  const map = new Map();
  if (!ids.length) return map;
  const rows = db
    .prepare(
      `SELECT id, item_id, kind, reaction, preset_text, recipient_user_id, created_at FROM grandma_events
        WHERE item_id IN (${placeholders(ids)}) AND kind IN ('reaction', 'preset')
        ORDER BY created_at, id`,
    )
    .all(...ids);
  for (const row of rows) {
    if (!map.has(row.item_id)) map.set(row.item_id, []);
    map.get(row.item_id).push({
      id: row.id,
      kind: row.kind,
      reaction: row.reaction,
      preset_text: row.preset_text,
      recipient_user_id: row.recipient_user_id,
      created_at: row.created_at,
    });
  }
  return map;
}

// Rows from `items` (joined with users as user_name / user_color) → API JSON.
export function serializeItems(db, rows, { user = null } = {}) {
  const ids = rows.map((r) => r.id);
  const renditions = renditionsByItem(db, ids);
  const grandma = grandmaEventsByItem(db, ids);
  return rows.map((row) => {
    const out = {
      id: row.id,
      kind: row.kind,
      status: row.status,
      caption: row.caption,
      batch_id: row.batch_id,
      created_at: row.created_at,
      ready_at: row.ready_at,
      width: row.width,
      height: row.height,
      duration_ms: row.duration_ms,
      user: {
        id: row.user_id,
        name: row.user_name ?? null,
        short_name: shortNameOf({ name: row.user_name, short_name: row.user_short_name }),
        color: row.user_color ?? null,
      },
      renditions: {},
      grandma_events: grandma.get(row.id) ?? [],
      can_edit: canEdit(row, user),
    };
    if (row.ready_at) {
      for (const r of renditions.get(row.id) ?? []) {
        out.renditions[r.name] = { url: mediaUrl(row, r.name), mime: r.mime, width: r.width, height: r.height };
      }
    }
    if (row.status === 'failed' && out.can_edit) out.error = row.error;
    return out;
  });
}

const ITEM_SELECT = `SELECT items.*, users.name AS user_name, users.short_name AS user_short_name, users.color AS user_color
                       FROM items JOIN users ON users.id = items.user_id`;

export function loadItemRow(db, id) {
  return db.prepare(`${ITEM_SELECT} WHERE items.id = ?`).get(id) ?? null;
}

// Deletes an item, its renditions, its original and any family voice notes on
// it. Grandma's Feed keeps its history (grandma_events.item_id becomes NULL).
export async function removeItem({ db, storage, log }, itemId) {
  const removed = immediate(db, () => {
    const item = db.prepare('SELECT id, original_path FROM items WHERE id = ?').get(itemId);
    if (!item) return null;
    const notes = db.prepare('SELECT id, original_path FROM voice_notes WHERE item_id = ?').all(itemId);
    cancelQueued(db, itemId);
    for (const note of notes) cancelQueued(db, note.id);
    db.prepare('DELETE FROM items WHERE id = ?').run(itemId);
    publish(db, 'item.removed', { item_id: itemId });
    return { item, notes };
  });
  if (!removed) return false;

  const cleanups = [storage.removeRenditions(itemId), storage.remove(removed.item.original_path)];
  for (const note of removed.notes) cleanups.push(storage.removeRenditions(note.id), storage.remove(note.original_path));
  for (const result of await Promise.allSettled(cleanups)) {
    if (result.status === 'rejected') log?.warn({ err: result.reason, itemId }, 'Could not remove a media file');
  }
  return true;
}

function parsePage(query) {
  const scope = query.scope ?? 'family';
  if (scope !== 'family' && scope !== 'mine') {
    throw httpError(400, 'bad_scope', 'That list does not exist. Try the family feed or your own uploads.');
  }
  const before = query.before || null;
  if (before !== null && !isId(before)) throw httpError(400, 'bad_cursor', "That page link didn't look right. Please reload.");
  let limit = query.limit === undefined ? PAGE_DEFAULT : Number(query.limit);
  if (!Number.isInteger(limit) || limit < 1) limit = PAGE_DEFAULT;
  return { scope, before, limit: Math.min(limit, PAGE_MAX) };
}

function editableItem(request) {
  const { id } = request.params;
  const item = isId(id) ? loadItemRow(request.server.db, id) : null;
  if (!item || !canView(item, request)) throw NOT_FOUND();
  if (!canEdit(item, request.user)) {
    throw httpError(403, 'forbidden', 'Only the person who shared this, or the family admin, can change it.');
  }
  return item;
}

export default async function itemRoutes(app, { db }) {
  app.get('/api/items', { preHandler: requireUser }, async (request) => {
    const { scope, before, limit } = parsePage(request.query);
    const conditions =
      scope === 'family'
        ? ["items.status = 'ready'"]
        : ['items.user_id = ?', "items.status IN ('ready', 'processing', 'failed')"];
    const params = scope === 'family' ? [] : [request.user.id];
    if (before) {
      conditions.push('items.id < ?');
      params.push(before);
    }
    const rows = db
      .prepare(`${ITEM_SELECT} WHERE ${conditions.join(' AND ')} ORDER BY items.id DESC LIMIT ?`)
      .all(...params, limit + 1);
    const page = rows.slice(0, limit);
    return {
      items: serializeItems(db, page, request),
      next_before: rows.length > limit ? page[page.length - 1].id : null,
    };
  });

  app.get('/api/items/:id', { preHandler: requireUser }, async (request) => {
    const { id } = request.params;
    const item = isId(id) ? loadItemRow(db, id) : null;
    if (!item || !canView(item, request)) throw NOT_FOUND();
    return { item: serializeItems(db, [item], request)[0] };
  });

  app.patch('/api/items/:id', { preHandler: requireUser }, async (request) => {
    const item = editableItem(request);
    const { caption } = request.body ?? {};
    if (caption !== null && typeof caption !== 'string') {
      throw httpError(400, 'bad_caption', 'Please send the caption as text.');
    }
    const clean = typeof caption === 'string' ? caption.trim() : '';
    if (clean.length > CAPTION_MAX) {
      throw httpError(400, 'caption_too_long', `That caption is too long. Please keep it under ${CAPTION_MAX} characters.`);
    }
    db.prepare('UPDATE items SET caption = ? WHERE id = ?').run(clean || null, item.id);
    return { item: serializeItems(db, [loadItemRow(db, item.id)], request)[0] };
  });

  app.delete('/api/items/:id', { preHandler: requireUser }, async (request) => {
    const item = editableItem(request);
    await removeItem({ db, storage: app.storage, log: request.log }, item.id);
    return { ok: true };
  });
}
