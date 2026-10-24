// Live events. The `events` table is an outbox: the app and the worker insert
// rows with publish(); the app's hub polls the table every second and fans new
// rows out to the SSE clients whose audience matches. Row ids are the SSE ids.
//
// Audiences: 'all' (every user and device), 'devices' (frames only),
// 'user:<id>' (one person), 'device:<id>' (one frame).

const RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const PRUNE_EVERY_MS = 60 * 60 * 1000;
const BATCH = 500;

function validAudience(audience) {
  return audience === 'all' || audience === 'devices' || /^(user|device):\S+$/.test(audience);
}

export function publish(db, topic, payload = {}, audience = 'all') {
  if (!topic || typeof topic !== 'string') throw new TypeError('publish needs a topic');
  if (!validAudience(audience)) throw new TypeError(`Unknown audience "${audience}"`);
  const info = db
    .prepare('INSERT INTO events (topic, audience, payload, created_at) VALUES (?, ?, ?, ?)')
    .run(topic, audience, JSON.stringify(payload ?? {}), Date.now());
  return Number(info.lastInsertRowid);
}

// Does an event for `audience` go to this client? `client` is { userId } or { deviceId }.
export function audienceMatches(audience, client) {
  if (audience === 'all') return true;
  if (audience === 'devices') return Boolean(client.deviceId);
  if (audience.startsWith('user:')) return Boolean(client.userId) && audience.slice(5) === client.userId;
  if (audience.startsWith('device:')) return Boolean(client.deviceId) && audience.slice(7) === client.deviceId;
  return false;
}

function toEvent(row) {
  let payload;
  try {
    payload = JSON.parse(row.payload);
  } catch {
    payload = {};
  }
  return { id: row.id, topic: row.topic, audience: row.audience, payload, createdAt: row.created_at };
}

export function latestEventId(db) {
  return db.prepare('SELECT COALESCE(MAX(id), 0) AS id FROM events').get().id;
}

// Rows after `afterId` (up to and including `untilId`, if given), oldest first.
export function eventsAfter(db, afterId, { untilId = null, limit = BATCH } = {}) {
  const rows =
    untilId === null
      ? db.prepare('SELECT * FROM events WHERE id > ? ORDER BY id LIMIT ?').all(afterId, limit)
      : db.prepare('SELECT * FROM events WHERE id > ? AND id <= ? ORDER BY id LIMIT ?').all(afterId, untilId, limit);
  return rows.map(toEvent);
}

export function pruneEvents(db, { olderThanMs = RETENTION_MS, now = Date.now() } = {}) {
  return db.prepare('DELETE FROM events WHERE created_at < ?').run(now - olderThanMs).changes;
}

// The in-process fan-out. One per app. It polls only while someone listens.
export function createEventHub(db, { intervalMs = 1000, log = null } = {}) {
  const subscribers = new Set();
  let cursor = 0;
  let timer = null;
  let lastPrune = 0;

  function deliver(events) {
    for (const event of events) {
      for (const sub of subscribers) {
        if (!audienceMatches(event.audience, sub.client)) continue;
        try {
          sub.onEvent(event);
        } catch (err) {
          log?.warn({ err }, 'SSE subscriber failed');
        }
      }
    }
  }

  function poll() {
    try {
      let events;
      do {
        events = eventsAfter(db, cursor);
        if (events.length) {
          cursor = events[events.length - 1].id;
          deliver(events);
        }
      } while (events.length === BATCH);
      if (Date.now() - lastPrune > PRUNE_EVERY_MS) {
        lastPrune = Date.now();
        pruneEvents(db);
      }
    } catch (err) {
      log?.error({ err }, 'Event poll failed');
    }
  }

  function start() {
    if (timer) return;
    cursor = latestEventId(db);
    timer = setInterval(poll, intervalMs);
    timer.unref();
  }

  function stopTimer() {
    clearInterval(timer);
    timer = null;
  }

  return {
    // Subscribe a client; returns an unsubscribe function. Synchronously after
    // subscribing, `hub.cursor` is the last id the hub has seen: replay anything
    // up to it yourself (eventsAfter(db, lastEventId, { untilId: hub.cursor }))
    // and the hub delivers everything after it.
    subscribe(client, onEvent, onClose = null) {
      start();
      const sub = { client, onEvent, onClose };
      subscribers.add(sub);
      return () => {
        subscribers.delete(sub);
        if (subscribers.size === 0) stopTimer();
      };
    },
    get cursor() {
      return cursor;
    },
    get size() {
      return subscribers.size;
    },
    poll,
    // Ends every stream (on shutdown) so the server can close.
    close() {
      stopTimer();
      for (const sub of [...subscribers]) {
        subscribers.delete(sub);
        try {
          sub.onClose?.();
        } catch {
          // already closed
        }
      }
    },
  };
}
