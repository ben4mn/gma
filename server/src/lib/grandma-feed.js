// Grandma's Feed: one reaction, preset message or voice note in the shape the
// family app, the frame and the grandma.event SSE payload share. Every person
// in it carries both `name` (full) and `short_name` (what Grandma calls them).

import { shortNameOf } from './people.js';
import { loadRenditions, renditionUrl, voiceUrl } from './renditions.js';

// The best small picture of an item: its thumb, else whatever still image it has.
function thumbUrl(row, renditions) {
  for (const name of ['thumb', 'display', 'poster']) {
    if (renditions?.[name]) return renditionUrl(row.item_id, name, row.item_ready_at);
  }
  return null;
}

export const FEED_SELECT = `
  SELECT e.id, e.kind, e.item_id, e.reaction, e.preset_id, e.preset_text, e.voice_note_id,
         e.recipient_user_id, e.created_at,
         i.kind AS item_kind, i.caption AS item_caption, i.status AS item_status,
         i.ready_at AS item_ready_at, i.user_id AS item_user_id,
         owner.name AS item_user_name, owner.short_name AS item_user_short_name,
         recipient.name AS recipient_name, recipient.short_name AS recipient_short_name,
         v.status AS voice_status, v.duration_ms AS voice_duration_ms, v.audio_path AS voice_audio_path
  FROM grandma_events e
  LEFT JOIN items i ON i.id = e.item_id
  LEFT JOIN users owner ON owner.id = i.user_id
  LEFT JOIN users recipient ON recipient.id = e.recipient_user_id
  LEFT JOIN voice_notes v ON v.id = e.voice_note_id`;

const SOMEONE = 'Someone in the family';

// A person in the feed: the full name for the family, the short name for the frame.
function person(id, name, shortName) {
  return { id, name: name ?? SOMEONE, short_name: shortNameOf({ name, short_name: shortName }) ?? SOMEONE };
}

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
      user: person(row.item_user_id, row.item_user_name, row.item_user_short_name),
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
    ? person(row.recipient_user_id, row.recipient_name, row.recipient_short_name)
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
    recipient_short_name: recipient ? recipient.short_name : 'everyone',
    voice_note: voiceNote,
  };
}

export function feedEventsJson(db, rows) {
  const renditions = loadRenditions(db, [...new Set(rows.map((r) => r.item_id).filter(Boolean))]);
  return rows.map((row) => feedEventJson(row, renditions.get(row.item_id)));
}

// One event in the feed's shape (used for the grandma.event SSE payload).
export function loadFeedEvent(db, eventId) {
  const row = db.prepare(`${FEED_SELECT} WHERE e.id = ?`).get(eventId);
  return row ? feedEventsJson(db, [row])[0] : null;
}
