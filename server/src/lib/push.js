// Web push (VAPID). Who gets what is in docs/ARCHITECTURE.md#push-who-gets-what:
// a reaction or a preset goes to the photo's owner, a voice note to everyone.
//
//   sendToUser(db, config, userId, payload, opts?)
//   sendToAll(db, config, payload, opts?)
//   notifyGrandmaEvent(db, config, eventId, opts?)
//
// Each returns { recipients, sent, failed, removed } and never throws for a
// push service failure. `opts.sender` replaces web-push's sendNotification
// (tests inject one); `opts.log` gets warnings.
//
// Payloads are declarative web push ({"web_push": 8030, "notification": {...}}),
// so Safari shows them without the service worker; the service worker's push
// handler shows the same fields everywhere else.

import webpush from 'web-push';
import { now } from './time.js';

export const PUSH_TTL_SECONDS = 2 * 24 * 60 * 60;
export const MAX_FAILURES = 5;
const SEND_TIMEOUT_MS = 15_000;
const CONCURRENCY = 8;
const MAX_PAYLOAD_BYTES = 2048;
const CAPTION_CHARS = 40;

export const REACTIONS = Object.freeze({
  love: { emoji: '❤️', label: 'Love', title: (what) => `Grandma loved your ${what}` },
  funny: { emoji: '😂', label: 'Funny', title: (what) => `Grandma found your ${what} funny` },
  wow: { emoji: '😮', label: 'Wow', title: (what) => `Grandma said wow to your ${what}` },
  thankful: { emoji: '🙏', label: 'Thankful', title: (what) => `Grandma is thankful for your ${what}` },
});

export function pushConfigured(config) {
  return Boolean(config.vapidPublicKey && config.vapidPrivateKey && config.vapidSubject);
}

function defaultSender(subscription, body, options) {
  return webpush.sendNotification(subscription, body, options);
}

// Runs `fn` over `list` with at most `limit` in flight; returns allSettled results in order.
async function settleAll(list, limit, fn) {
  const results = new Array(list.length);
  let next = 0;
  async function lane() {
    while (next < list.length) {
      const index = next++;
      try {
        results[index] = { status: 'fulfilled', value: await fn(list[index]) };
      } catch (reason) {
        results[index] = { status: 'rejected', reason };
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, list.length) }, lane));
  return results;
}

function recordResults(db, subs, results) {
  const succeeded = db.prepare('UPDATE push_subscriptions SET failures = 0, last_success_at = ? WHERE id = ?');
  const gone = db.prepare('DELETE FROM push_subscriptions WHERE id = ?');
  const failedOnce = db.prepare('UPDATE push_subscriptions SET failures = failures + 1 WHERE id = ?');
  const dropDead = db.prepare('DELETE FROM push_subscriptions WHERE id = ? AND failures >= ?');
  const tally = { sent: 0, failed: 0, removed: 0 };
  const at = now();

  db.transaction(() => {
    results.forEach((result, i) => {
      const sub = subs[i];
      if (result.status === 'fulfilled') {
        succeeded.run(at, sub.id);
        tally.sent += 1;
        return;
      }
      tally.failed += 1;
      const status = result.reason?.statusCode;
      // 404/410: the browser dropped this subscription; it will never work again.
      if (status === 404 || status === 410) {
        tally.removed += gone.run(sub.id).changes;
        return;
      }
      failedOnce.run(sub.id);
      tally.removed += dropDead.run(sub.id, MAX_FAILURES).changes;
    });
  })();
  return tally;
}

async function sendToSubscriptions(db, config, subs, payload, { sender = defaultSender, log = null } = {}) {
  const recipients = new Set(subs.map((s) => s.user_id)).size;
  const empty = { recipients, sent: 0, failed: 0, removed: 0 };
  if (subs.length === 0) return empty;
  if (!pushConfigured(config)) {
    log?.warn('Push skipped: VAPID keys are not configured');
    return empty;
  }

  const body = JSON.stringify(payload);
  if (Buffer.byteLength(body) > MAX_PAYLOAD_BYTES) {
    throw new RangeError(`Push payload is ${Buffer.byteLength(body)} bytes; the limit is ${MAX_PAYLOAD_BYTES}`);
  }
  const options = {
    TTL: PUSH_TTL_SECONDS,
    urgency: 'normal',
    timeout: SEND_TIMEOUT_MS,
    vapidDetails: {
      subject: config.vapidSubject,
      publicKey: config.vapidPublicKey,
      privateKey: config.vapidPrivateKey,
    },
  };

  const results = await settleAll(subs, CONCURRENCY, (sub) =>
    sender({ endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } }, body, options),
  );
  for (const [i, result] of results.entries()) {
    if (result.status === 'rejected') {
      // Never log the endpoint: it is a bearer capability for that phone.
      log?.warn(
        { statusCode: result.reason?.statusCode ?? null, subscription: subs[i].id },
        'Push delivery failed',
      );
    }
  }
  return { recipients, ...recordResults(db, subs, results) };
}

export async function sendToUser(db, config, userId, payload, opts = {}) {
  const subs = db
    .prepare(
      `SELECT s.* FROM push_subscriptions s JOIN users u ON u.id = s.user_id
       WHERE s.user_id = ? AND u.status = 'active'`,
    )
    .all(userId);
  return sendToSubscriptions(db, config, subs, payload, opts);
}

export async function sendToAll(db, config, payload, opts = {}) {
  const subs = db
    .prepare(
      `SELECT s.* FROM push_subscriptions s JOIN users u ON u.id = s.user_id
       WHERE u.status = 'active'`,
    )
    .all();
  return sendToSubscriptions(db, config, subs, payload, opts);
}

// "Lily at the farm with…" — short enough for a lock screen.
function snippet(text, max = CAPTION_CHARS) {
  const clean = String(text ?? '').replace(/\s+/g, ' ').trim();
  if (clean.length <= max) return clean;
  let cut = clean.slice(0, max - 1);
  const lastSpace = cut.lastIndexOf(' ');
  // End on a whole word unless that would throw away most of the snippet.
  if (clean[max - 1] !== ' ' && lastSpace > max / 2) cut = cut.slice(0, lastSpace);
  return `${cut.trimEnd()}…`;
}

export function formatDuration(ms) {
  const total = Math.max(0, Math.round((ms ?? 0) / 1000));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

function notification(config, eventId, fields) {
  return {
    web_push: 8030,
    notification: {
      ...fields,
      navigate: `${config.publicOrigin}/from-grandma#e-${eventId}`,
    },
  };
}

// The push payload for one Grandma event (a row joined with its item and voice
// note, see loadEventForPush). Exported for tests.
export function grandmaEventPayload(config, event) {
  const what = event.item_kind === 'video' ? 'video' : 'photo';
  if (event.kind === 'reaction') {
    const reaction = REACTIONS[event.reaction];
    const caption = snippet(event.item_caption);
    return notification(config, event.id, {
      title: reaction.title(what),
      body: caption ? `${reaction.emoji} ${reaction.label} · “${caption}”` : `${reaction.emoji} ${reaction.label}`,
      tag: `grandma-${event.item_id}`,
    });
  }
  if (event.kind === 'preset') {
    return notification(config, event.id, {
      title: 'Grandma sent you a message',
      body: `“${snippet(event.preset_text, 60)}” · about your ${what}`,
      tag: `grandma-${event.item_id}`,
    });
  }
  if (event.kind === 'voice') {
    return notification(config, event.id, {
      title: 'Grandma sent a voice message',
      body: event.voice_duration_ms ? `Tap to listen (${formatDuration(event.voice_duration_ms)})` : 'Tap to listen',
      tag: `grandma-voice-${event.id}`,
    });
  }
  throw new TypeError(`Unknown Grandma event kind "${event.kind}"`);
}

function loadEventForPush(db, eventId) {
  return db
    .prepare(
      `SELECT e.*, i.kind AS item_kind, i.caption AS item_caption, i.user_id AS item_user_id,
              v.duration_ms AS voice_duration_ms
       FROM grandma_events e
       LEFT JOIN items i ON i.id = e.item_id
       LEFT JOIN voice_notes v ON v.id = e.voice_note_id
       WHERE e.id = ?`,
    )
    .get(eventId);
}

// Sends the push for one Grandma event to the right people. Safe to call from
// the app (reactions, presets) and the worker (voice notes). Returns null when
// the event doesn't exist or has nobody to tell.
export async function notifyGrandmaEvent(db, config, eventId, opts = {}) {
  const event = loadEventForPush(db, eventId);
  if (!event) return null;
  const payload = grandmaEventPayload(config, event);
  if (event.kind === 'voice') return sendToAll(db, config, payload, opts);
  if (!event.recipient_user_id) return null;
  return sendToUser(db, config, event.recipient_user_id, payload, opts);
}
