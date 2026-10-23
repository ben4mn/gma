// Grandma's Feed: GET /api/grandma-events?before=<id>&limit=
//
// Every reaction, preset message and voice note from the frame, newest first.
// The feed is shared (DECISIONS.md, 2026-10-22): every relative sees every
// event, with the photo it was about, who sent that photo and who it went to.
//
// This file also holds the small item serializers the frame routes reuse
// (renditionUrl, loadRenditions, itemJson), so both speak one item shape.

import { requireUser, httpError } from '../lib/guards.js';
import { isId } from '../lib/ids.js';

const DEFAULT_LIMIT = 30;
const MAX_LIMIT = 100;

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

// The client-facing item: `row` is an items row with `user_name` joined in.
export function itemJson(row, renditions = {}) {
  const urls = {};
  for (const [name, dims] of Object.entries(renditions)) {
    // The audio rendition belongs to voice notes, never to a photo or video.
    if (name === 'audio') continue;
    urls[name] = { url: renditionUrl(row.id, name, row.ready_at), width: dims.width, height: dims.height };
  }
  return {
    id: row.id,
    kind: row.kind,
    caption: row.caption ?? null,
    batch_id: row.batch_id ?? null,
    sender: { id: row.user_id, name: row.user_name ?? 'Someone in the family' },
    created_at: row.created_at,
    ready_at: row.ready_at,
    width: row.width ?? null,
    height: row.height ?? null,
    duration_ms: row.duration_ms ?? null,
    renditions: urls,
  };
}

// The best small picture of an item: its thumb, else whatever still image it has.
function thumbUrl(row, renditions) {
  for (const name of ['thumb', 'display', 'poster']) {
    if (renditions?.[name]) return renditionUrl(row.item_id, name, row.item_ready_at);
  }
  return null;
}

const FEED_SELECT = `
  SELECT e.id, e.kind, e.item_id, e.reaction, e.preset_id, e.preset_text, e.voice_note_id,
         e.recipient_user_id, e.created_at,
         i.kind AS item_kind, i.caption AS item_caption, i.status AS item_status,
         i.ready_at AS item_ready_at, i.user_id AS item_user_id,
         owner.name AS item_user_name,
         recipient.name AS recipient_name,
         v.status AS voice_status, v.duration_ms AS voice_duration_ms, v.audio_path AS voice_audio_path
  FROM grandma_events e
  LEFT JOIN items i ON i.id = e.item_id
  LEFT JOIN users owner ON owner.id = i.user_id
  LEFT JOIN users recipient ON recipient.id = e.recipient_user_id
  LEFT JOIN voice_notes v ON v.id = e.voice_note_id`;

function feedEventJson(row, renditions) {
  let item = null;
  if (row.item_id && row.item_kind) {
    // A hidden or failed item keeps its place in the feed but shows no picture or words.
    const visible = row.item_status === 'ready';
    item = {
      id: row.item_id,
      kind: row.item_kind,
      caption: visible ? row.item_caption ?? null : null,
      ready_at: visible ? row.item_ready_at : null,
      available: visible,
      thumb_url: visible ? thumbUrl(row, renditions) : null,
      user: { id: row.item_user_id, name: row.item_user_name ?? 'Someone in the family' },
    };
  }

  let voiceNote = null;
  if (row.kind === 'voice' && row.voice_note_id) {
    const ready = row.voice_status === 'ready' && Boolean(row.voice_audio_path);
    voiceNote = {
      id: row.voice_note_id,
      status: row.voice_status ?? 'failed',
      duration_ms: row.voice_duration_ms ?? null,
      url: ready ? voiceUrl(row.voice_note_id) : null,
    };
  }

  const recipient = row.recipient_user_id
    ? { id: row.recipient_user_id, name: row.recipient_name ?? 'Someone in the family' }
    : null;

  return {
    id: row.id,
    kind: row.kind,
    created_at: row.created_at,
    reaction: row.reaction ?? null,
    preset_id: row.preset_id ?? null,
    preset_text: row.preset_text ?? null,
    item,
    thumb_url: item?.thumb_url ?? null,
    sender: item?.user ?? null,
    recipient_user_id: row.recipient_user_id ?? null,
    recipient,
    recipient_name: recipient ? recipient.name : 'everyone',
    voice_note: voiceNote,
  };
}

function feedEventsJson(db, rows) {
  const renditions = loadRenditions(db, [...new Set(rows.map((r) => r.item_id).filter(Boolean))]);
  return rows.map((row) => feedEventJson(row, renditions.get(row.item_id)));
}

// One event in the feed's shape (used for the grandma.event SSE payload).
export function loadFeedEvent(db, eventId) {
  const row = db.prepare(`${FEED_SELECT} WHERE e.id = ?`).get(eventId);
  return row ? feedEventsJson(db, [row])[0] : null;
}

export function parseLimit(raw, fallback = DEFAULT_LIMIT, max = MAX_LIMIT) {
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) throw httpError(400, 'bad_limit', 'The page size must be a whole number.');
  return Math.min(n, max);
}

export default async function grandmaEventRoutes(app, { db }) {
  app.get('/api/grandma-events', { preHandler: requireUser }, async (request) => {
    const { before } = request.query;
    const limit = parseLimit(request.query.limit);
    if (before !== undefined && !isId(before)) {
      throw httpError(400, 'bad_cursor', "That page link didn't look right. Please reload.");
    }

    // ULIDs sort by creation time, so the id is the feed's time order and its cursor.
    const rows = before
      ? db.prepare(`${FEED_SELECT} WHERE e.id < ? ORDER BY e.id DESC LIMIT ?`).all(before, limit)
      : db.prepare(`${FEED_SELECT} ORDER BY e.id DESC LIMIT ?`).all(limit);

    return {
      events: feedEventsJson(db, rows),
      next_before: rows.length === limit ? rows.at(-1).id : null,
    };
  });
}
