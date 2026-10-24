// Core: the live stream, GET /api/events. inject can't hold a stream open, so
// these tests listen on an ephemeral port (port 0) on 127.0.0.1.

import assert from 'node:assert/strict';
import http from 'node:http';
import { after, before, describe, test } from 'node:test';
import { publish } from '../src/lib/events.js';
import { loginAs, loginAsDevice, makeDevice, makeTestApp, makeUser } from './helpers/index.js';

// Opens the stream and collects parsed events. `next(predicate)` waits for one.
function openStream(base, { cookie, lastEventId } = {}) {
  return new Promise((resolve, reject) => {
    const headers = {};
    if (cookie) headers.cookie = cookie;
    if (lastEventId !== undefined) headers['last-event-id'] = String(lastEventId);
    const req = http.get(`${base}/api/events`, { headers }, (res) => {
      const stream = { res, raw: '', events: [], comments: 0, waiters: [] };
      res.setEncoding('utf8');
      res.on('data', (chunk) => {
        stream.raw += chunk;
        let end;
        while ((end = stream.raw.indexOf('\n\n')) !== -1) {
          const block = stream.raw.slice(0, end);
          stream.raw = stream.raw.slice(end + 2);
          const event = {};
          for (const line of block.split('\n')) {
            if (line.startsWith(':')) stream.comments += 1;
            const at = line.indexOf(': ');
            if (at > 0) event[line.slice(0, at)] = line.slice(at + 2);
          }
          if (event.event) stream.events.push({ ...event, data: JSON.parse(event.data) });
          for (const w of [...stream.waiters]) w();
        }
      });
      stream.next = (predicate, timeoutMs = 3000) =>
        new Promise((done, fail) => {
          const check = () => {
            const found = stream.events.find(predicate);
            if (found) {
              stream.waiters = stream.waiters.filter((w) => w !== check);
              clearTimeout(timer);
              done(found);
            }
          };
          const timer = setTimeout(() => fail(new Error('Timed out waiting for an event')), timeoutMs);
          stream.waiters.push(check);
          check();
        });
      stream.close = () => req.destroy();
      resolve(stream);
    });
    req.on('error', reject);
  });
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

describe('GET /api/events', () => {
  let t;
  let base;
  let alice;
  let bob;
  let frame;
  before(async () => {
    t = await makeTestApp({ routeOptions: { sseHeartbeatMs: 100 } });
    base = await t.app.listen({ host: '127.0.0.1', port: 0 });
    alice = makeUser(t.db, { name: 'Alice' });
    bob = makeUser(t.db, { name: 'Bob' });
    frame = makeDevice(t.db);
  });
  after(async () => {
    await t.cleanup();
  });

  test('refuses a visitor without a session', async () => {
    const res = await fetch(`${base}/api/events`);
    assert.equal(res.status, 401);
    assert.equal((await res.json()).error.code, 'unauthorized');
  });

  test('streams with the right headers, and keeps the connection warm', async () => {
    const stream = await openStream(base, { cookie: loginAs(t.app, t.db, alice) });
    try {
      assert.equal(stream.res.statusCode, 200);
      assert.equal(stream.res.headers['content-type'], 'text/event-stream; charset=utf-8');
      assert.equal(stream.res.headers['x-accel-buffering'], 'no');
      assert.match(stream.res.headers['cache-control'], /no-cache/);
      assert.equal(stream.res.headers['x-robots-tag'], 'noindex, nofollow');
      await wait(350);
      assert.ok(stream.comments >= 2, `expected heartbeat comments, got ${stream.comments}`);
    } finally {
      stream.close();
    }
  });

  test('delivers events by audience', async () => {
    const aliceStream = await openStream(base, { cookie: loginAs(t.app, t.db, alice) });
    const frameStream = await openStream(base, { cookie: loginAsDevice(t.app, t.db, frame) });
    try {
      publish(t.db, 'item.failed', { item_id: 'b1' }, `user:${bob.id}`);
      publish(t.db, 'item.failed', { item_id: 'a1' }, `user:${alice.id}`);
      publish(t.db, 'frame.reload', {}, 'devices');
      const readyId = publish(t.db, 'item.ready', { item_id: 'x1' });

      const ready = await aliceStream.next((e) => e.event === 'item.ready');
      assert.equal(Number(ready.id), readyId);
      assert.deepEqual(ready.data, { item_id: 'x1' });
      await frameStream.next((e) => e.event === 'item.ready');

      assert.deepEqual(
        aliceStream.events.map((e) => [e.event, e.data.item_id]),
        [['item.failed', 'a1'], ['item.ready', 'x1']],
        "Alice sees her own failure and shared events, not Bob's or the frame's",
      );
      assert.deepEqual(
        frameStream.events.map((e) => e.event),
        ['frame.reload', 'item.ready'],
      );
    } finally {
      aliceStream.close();
      frameStream.close();
    }
  });

  test('Last-Event-ID replays what was missed, filtered by audience', async () => {
    const cookie = loginAs(t.app, t.db, alice);
    const first = await openStream(base, { cookie });
    const seenId = publish(t.db, 'item.ready', { item_id: 'r0' });
    await first.next((e) => Number(e.id) === seenId);
    first.close();

    // Keep the hub running (another listener) so it moves past the missed rows.
    const other = await openStream(base, { cookie: loginAs(t.app, t.db, bob) });
    publish(t.db, 'item.ready', { item_id: 'r1' });
    publish(t.db, 'item.failed', { item_id: 'secret' }, `user:${bob.id}`);
    const lastId = publish(t.db, 'grandma.event', { id: 'g1' });
    await other.next((e) => Number(e.id) === lastId);

    const resumed = await openStream(base, { cookie, lastEventId: seenId });
    try {
      await resumed.next((e) => e.event === 'grandma.event');
      assert.deepEqual(
        resumed.events.map((e) => e.event),
        ['item.ready', 'grandma.event'],
      );
      const live = publish(t.db, 'settings.changed', {});
      const fresh = await resumed.next((e) => Number(e.id) === live);
      assert.equal(fresh.event, 'settings.changed');
    } finally {
      resumed.close();
      other.close();
    }
  });

  test('asks the client to resync when the missed events were pruned', async () => {
    const cookie = loginAs(t.app, t.db, alice);
    const keeper = await openStream(base, { cookie: loginAs(t.app, t.db, bob) });
    const gone = publish(t.db, 'item.ready', { item_id: 'old' });
    const kept = publish(t.db, 'item.ready', { item_id: 'new' });
    await keeper.next((e) => Number(e.id) === kept);
    t.db.prepare('DELETE FROM events WHERE id = ?').run(gone);

    const resumed = await openStream(base, { cookie, lastEventId: gone - 1 });
    try {
      const resync = await resumed.next((e) => e.event === 'resync');
      assert.equal(Number(resync.id), kept);
      assert.equal(resumed.events.length, 1);
    } finally {
      resumed.close();
      keeper.close();
    }
  });

  test('closing the app ends open streams', async () => {
    const own = await makeTestApp();
    const ownBase = await own.app.listen({ host: '127.0.0.1', port: 0 });
    const stream = await openStream(ownBase, { cookie: loginAs(own.app, own.db, makeUser(own.db)) });
    const ended = new Promise((resolve) => stream.res.on('end', resolve));
    await own.cleanup();
    await ended;
    assert.equal(own.app.events.size, 0);
  });
});
