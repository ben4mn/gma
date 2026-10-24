// The voice job: Grandma's recording (WebM/Opus, MP4/AAC or Ogg) → a mono
// 64 kb/s AAC M4A, trimmed at 65 s. When it is ready and came from the frame,
// it becomes a grandma_events row (kind voice, to everyone), a grandma.event
// on the live stream, and a push to every relative.

import { publish } from '../lib/events.js';
import { newId } from '../lib/ids.js';
import { AUDIO_RENDITION } from '../lib/media.js';
import { writeRendition } from './items.js';
import { immediate } from '../lib/tx.js';

function loadVoiceNote(db, id) {
  return db.prepare('SELECT * FROM voice_notes WHERE id = ?').get(id) ?? null;
}

// lib/push.js belongs to the frame area. Until it exists, voice notes still
// reach Grandma's Feed; they just don't push.
async function loadPush(log) {
  try {
    return await import('../lib/push.js');
  } catch (err) {
    if (err.code !== 'ERR_MODULE_NOT_FOUND') log?.error?.(`Could not load lib/push.js: ${err.message}`);
    return null;
  }
}

async function notify(ctx, eventId) {
  const push = ctx.push ?? (await loadPush(ctx.log));
  if (typeof push?.notifyGrandmaEvent !== 'function') return;
  try {
    await push.notifyGrandmaEvent(ctx.db, ctx.config, eventId);
  } catch (err) {
    // The event is saved and on the live stream; a failed push must not re-run the job.
    ctx.log?.warn?.(`Push for voice event ${eventId} failed: ${err.message}`);
  }
}

// Saves the audio and creates the frame's event (once). → the new event id, or null.
function recordReady(db, note, { audioPath, durationMs }) {
  return immediate(db, () => {
    const current = db.prepare('SELECT id FROM voice_notes WHERE id = ?').get(note.id);
    if (!current) return null;
    db.prepare(
      "UPDATE voice_notes SET status = 'ready', audio_path = ?, duration_ms = COALESCE(?, duration_ms) WHERE id = ?",
    ).run(audioPath, durationMs, note.id);

    if (!note.device_id) return null; // a family note on an upload: not one of Grandma's events
    const existing = db.prepare('SELECT id FROM grandma_events WHERE voice_note_id = ?').get(note.id);
    if (existing) return null;
    const eventId = newId();
    const inserted = db
      .prepare(
        `INSERT OR IGNORE INTO grandma_events (id, device_id, kind, voice_note_id, recipient_user_id, client_id, created_at)
         VALUES (?, ?, 'voice', ?, NULL, ?, ?)`,
      )
      .run(eventId, note.device_id, note.id, note.client_id ?? null, Date.now());
    if (!inserted.changes) return null;
    publish(db, 'grandma.event', { id: eventId, kind: 'voice', voice_note_id: note.id, item_id: note.item_id ?? null });
    return eventId;
  });
}

export async function run(ctx, job) {
  const { db, storage, media, signal } = ctx;
  const note = loadVoiceNote(db, job.ref_id);
  if (!note) return;
  const input = storage.resolve(note.original_path);

  let durationMs = null;
  const rendition = await writeRendition(storage, note.id, AUDIO_RENDITION, async (out) => {
    await media.transcodeVoice({ input, output: out }, { signal });
    durationMs = (await media.probe(out, { signal })).durationMs;
  });

  const eventId = recordReady(db, note, { audioPath: rendition.path, durationMs });
  if (eventId) await notify(ctx, eventId);
}

// The voice note was deleted while the job ran: the runner then marks the job done.
export function isGone({ db }, job) {
  return !loadVoiceNote(db, job.ref_id);
}

export function onFailed({ db, log }, job) {
  db.prepare("UPDATE voice_notes SET status = 'failed' WHERE id = ? AND status = 'processing'").run(job.ref_id);
  log?.warn?.(`Voice note ${job.ref_id} could not be converted`);
}
