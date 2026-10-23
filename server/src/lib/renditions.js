// Rendition URLs and the frame's item shape, shared by the frame and Grandma's
// Feed routes so both speak one item shape.

import { shortNameOf } from './people.js';

// Media URLs carry ?v=<ready_at> so the year-long cache never serves a stale
// rendition after an item is reprocessed.
export function renditionUrl(itemId, name, readyAt) {
  const v = readyAt ? `?v=${readyAt}` : '';
  return `/media/${encodeURIComponent(itemId)}/${name}${v}`;
}

export function voiceUrl(voiceId) {
  return `/media/voice/${encodeURIComponent(voiceId)}`;
}

// Map of item id → { name: { width, height } } for the given items.
export function loadRenditions(db, itemIds) {
  const byItem = new Map();
  if (itemIds.length === 0) return byItem;
  const rows = db
    .prepare(
      `SELECT item_id, name, width, height FROM renditions
       WHERE item_id IN (SELECT value FROM json_each(?))`,
    )
    .all(JSON.stringify(itemIds));
  for (const row of rows) {
    if (!byItem.has(row.item_id)) byItem.set(row.item_id, {});
    byItem.get(row.item_id)[row.name] = { width: row.width, height: row.height };
  }
  return byItem;
}

// The frame's item: `row` is an items row with `user_name` and `user_short_name`
// joined in. The sender's `name` is their short name (what Grandma calls them).
export function itemJson(row, renditions = {}) {
  const urls = {};
  for (const [name, dims] of Object.entries(renditions)) {
    // The audio rendition belongs to voice notes, never to a photo or video.
    if (name === 'audio') continue;
    urls[name] = { url: renditionUrl(row.id, name, row.ready_at), width: dims.width, height: dims.height };
  }
  // The frame shows what Grandma calls them; full_name is there for anything that needs it.
  const shortName = shortNameOf({ name: row.user_name, short_name: row.user_short_name }) ?? 'Someone in the family';
  return {
    id: row.id,
    kind: row.kind,
    caption: row.caption ?? null,
    batch_id: row.batch_id ?? null,
    sender: { id: row.user_id, name: shortName, short_name: shortName, full_name: row.user_name ?? null },
    created_at: row.created_at,
    ready_at: row.ready_at,
    width: row.width ?? null,
    height: row.height ?? null,
    duration_ms: row.duration_ms ?? null,
    renditions: urls,
  };
}
