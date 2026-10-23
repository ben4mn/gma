// GET /api/events: the live stream (Server-Sent Events) for the family app and
// the frame. Each event is
//
//   id: <events row id>
//   event: <topic>            item.ready, grandma.event, frame.reload, …
//   data: <payload JSON>
//
// A comment line every 25 s keeps proxies from closing the connection. On
// reconnect the browser sends Last-Event-ID and missed events are replayed.
// If too many were missed, or some were already pruned, a `resync` event
// (data {}) tells the client to reload its state instead.

import { audienceMatches, eventsAfter } from '../lib/events.js';
import { requireUserOrDevice } from '../lib/guards.js';

const HEARTBEAT_MS = 25_000;
const MAX_REPLAY = 500;

function parseLastEventId(request) {
  const raw = request.headers['last-event-id'] ?? request.query?.last_event_id;
  if (raw === undefined || raw === '') return null;
  const id = Number(raw);
  return Number.isSafeInteger(id) && id >= 0 ? id : null;
}

export function formatEvent(event) {
  return `id: ${event.id}\nevent: ${event.topic}\ndata: ${JSON.stringify(event.payload)}\n\n`;
}

// What to send a reconnecting client: the missed events it may see, or a resync.
function replay(db, client, lastEventId, cursor) {
  if (lastEventId === null || lastEventId === cursor) return [];
  const resync = [{ id: cursor, topic: 'resync', payload: {} }];
  if (lastEventId > cursor) return resync; // the database was restored or reset
  const missed = eventsAfter(db, lastEventId, { untilId: cursor, limit: MAX_REPLAY + 1 });
  const pruned = missed.length === 0 || missed[0].id !== lastEventId + 1;
  if (pruned || missed.length > MAX_REPLAY) return resync;
  return missed.filter((event) => audienceMatches(event.audience, client));
}

export default async function eventRoutes(app, opts) {
  const heartbeatMs = opts.sseHeartbeatMs ?? HEARTBEAT_MS;

  app.get('/api/events', { preHandler: requireUserOrDevice }, (request, reply) => {
    const client = request.device ? { deviceId: request.device.id } : { userId: request.user.id };
    const lastEventId = parseLastEventId(request);

    reply.hijack();
    const res = reply.raw;
    res.writeHead(200, {
      ...reply.getHeaders(),
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });

    let open = true;
    let unsubscribe = () => {};
    const write = (chunk) => {
      if (open) res.write(chunk);
    };
    const heartbeat = setInterval(() => write(': ping\n\n'), heartbeatMs);
    heartbeat.unref();

    const close = () => {
      if (!open) return;
      open = false;
      clearInterval(heartbeat);
      unsubscribe();
      res.end();
    };
    request.raw.on('close', close);
    res.on('error', close);

    write('retry: 3000\n\n');

    // Subscribe and replay in the same tick: the hub delivers everything after
    // hub.cursor; the replay covers (lastEventId, hub.cursor].
    unsubscribe = app.events.subscribe(client, (event) => write(formatEvent(event)), close);
    for (const event of replay(app.db, client, lastEventId, app.events.cursor)) write(formatEvent(event));
  });
}
