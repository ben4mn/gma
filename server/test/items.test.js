import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { makeTestApp, makeUser, makeDevice, loginAs, sameOrigin } from './helpers/index.js';
import { newId } from '../src/lib/ids.js';
import { enqueue } from '../src/jobs/queue.js';
import { eventsAfter } from '../src/lib/events.js';

// An item row plus rendition rows and files, as the worker would leave it.
async function addItem(ctx, user, { status = 'ready', caption = null, kind = 'photo', names = ['thumb', 'display'] } = {}) {
  const id = newId();
  const now = Date.now();
  const original = ctx.app.storage.originalKey(id, 'jpg', now);
  await fs.writeFile(await ctx.app.storage.ensureDirFor(original), 'original');
  ctx.db
    .prepare(
      `INSERT INTO items (id, user_id, kind, caption, status, original_path, original_mime, created_at, ready_at, width, height)
       VALUES (?, ?, ?, ?, ?, ?, 'image/jpeg', ?, ?, 1600, 1067)`,
    )
    .run(id, user.id, kind, caption, status, original, now, status === 'ready' ? now : null);
  if (status === 'ready') {
    for (const name of names) {
      const key = ctx.app.storage.renditionKey(id, name, name === 'thumb' ? 'webp' : 'jpg');
      await fs.writeFile(await ctx.app.storage.ensureDirFor(key), `${name} bytes`);
      ctx.db
        .prepare('INSERT INTO renditions (item_id, name, path, mime, width, height, bytes) VALUES (?, ?, ?, ?, 480, 320, 10)')
        .run(id, name, key, name === 'thumb' ? 'image/webp' : 'image/jpeg');
    }
  }
  return ctx.db.prepare('SELECT * FROM items WHERE id = ?').get(id);
}

function addReaction(ctx, item, device, reaction = 'love') {
  ctx.db
    .prepare(
      `INSERT INTO grandma_events (id, device_id, kind, item_id, reaction, recipient_user_id, client_id, created_at)
       VALUES (?, ?, 'reaction', ?, ?, ?, ?, ?)`,
    )
    .run(newId(), device.id, item.id, reaction, item.user_id, newId(), Date.now());
}

test('the family feed lists ready items newest first, with renditions, the sender and Grandma\'s reactions', async (t) => {
  const ctx = await makeTestApp();
  t.after(ctx.cleanup);
  const sarah = makeUser(ctx.db, { name: 'Sarah', color: '#3A5236' });
  const mike = makeUser(ctx.db, { name: 'Mike' });
  const device = makeDevice(ctx.db);
  const older = await addItem(ctx, sarah, { caption: 'Lily at the farm' });
  const newer = await addItem(ctx, mike);
  await addItem(ctx, mike, { status: 'processing' });
  await addItem(ctx, mike, { status: 'hidden' });
  addReaction(ctx, older, device, 'love');

  const res = await ctx.app.inject({ url: '/api/items?scope=family', headers: { cookie: loginAs(ctx.app, ctx.db, mike) } });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.deepEqual(body.items.map((i) => i.id), [newer.id, older.id]);
  assert.equal(body.next_before, null);

  const item = body.items[1];
  assert.equal(item.caption, 'Lily at the farm');
  assert.deepEqual(item.user, { id: sarah.id, name: 'Sarah', color: '#3A5236' });
  assert.equal(item.can_edit, false);
  assert.equal(item.renditions.display.url, `/media/${older.id}/display?v=${older.ready_at}`);
  assert.equal(item.renditions.thumb.mime, 'image/webp');
  assert.equal(item.grandma_events.length, 1);
  assert.equal(item.grandma_events[0].reaction, 'love');
  assert.equal(body.items[0].can_edit, true);
});

test('pages with ?before= and limit', async (t) => {
  const ctx = await makeTestApp();
  t.after(ctx.cleanup);
  const user = makeUser(ctx.db);
  const cookie = loginAs(ctx.app, ctx.db, user);
  const ids = [];
  for (let i = 0; i < 5; i++) ids.push((await addItem(ctx, user)).id);
  ids.reverse();

  const first = (await ctx.app.inject({ url: '/api/items?limit=2', headers: { cookie } })).json();
  assert.deepEqual(first.items.map((i) => i.id), ids.slice(0, 2));
  assert.equal(first.next_before, ids[1]);
  const second = (await ctx.app.inject({ url: `/api/items?limit=2&before=${first.next_before}`, headers: { cookie } })).json();
  assert.deepEqual(second.items.map((i) => i.id), ids.slice(2, 4));
  const last = (await ctx.app.inject({ url: `/api/items?limit=2&before=${second.next_before}`, headers: { cookie } })).json();
  assert.deepEqual(last.items.map((i) => i.id), ids.slice(4));
  assert.equal(last.next_before, null);

  const bad = await ctx.app.inject({ url: '/api/items?before=nope', headers: { cookie } });
  assert.equal(bad.statusCode, 400);
  const scope = await ctx.app.inject({ url: '/api/items?scope=everyone', headers: { cookie } });
  assert.equal(scope.statusCode, 400);
});

test('Mine adds your own processing and failed uploads (with the kind error), never other people\'s', async (t) => {
  const ctx = await makeTestApp();
  t.after(ctx.cleanup);
  const me = makeUser(ctx.db);
  const other = makeUser(ctx.db);
  const ready = await addItem(ctx, me);
  const processing = await addItem(ctx, me, { status: 'processing' });
  const failed = await addItem(ctx, me, { status: 'failed' });
  ctx.db.prepare('UPDATE items SET error = ? WHERE id = ?').run('This video is too long.', failed.id);
  await addItem(ctx, other);

  const res = await ctx.app.inject({ url: '/api/items?scope=mine', headers: { cookie: loginAs(ctx.app, ctx.db, me) } });
  const items = res.json().items;
  assert.deepEqual(new Set(items.map((i) => i.id)), new Set([ready.id, processing.id, failed.id]));
  const f = items.find((i) => i.id === failed.id);
  assert.equal(f.status, 'failed');
  assert.equal(f.error, 'This video is too long.');
  assert.deepEqual(items.find((i) => i.id === processing.id).renditions, {});
});

test('GET /api/items/:id shows ready items to everyone and the rest only to the owner or admin', async (t) => {
  const ctx = await makeTestApp();
  t.after(ctx.cleanup);
  const owner = makeUser(ctx.db);
  const other = makeUser(ctx.db);
  const admin = makeUser(ctx.db, { role: 'admin' });
  const ready = await addItem(ctx, owner);
  const processing = await addItem(ctx, owner, { status: 'processing' });
  const get = (item, user) => ctx.app.inject({ url: `/api/items/${item.id}`, headers: { cookie: loginAs(ctx.app, ctx.db, user) } });

  assert.equal((await get(ready, other)).statusCode, 200);
  assert.equal((await get(ready, other)).json().item.id, ready.id);
  assert.equal((await get(processing, other)).statusCode, 404);
  assert.equal((await get(processing, owner)).statusCode, 200);
  assert.equal((await get(processing, admin)).statusCode, 200);
  assert.equal((await ctx.app.inject({ url: `/api/items/${ready.id}` })).statusCode, 401);
  assert.equal((await ctx.app.inject({ url: '/api/items/not-an-id', headers: { cookie: loginAs(ctx.app, ctx.db, owner) } })).statusCode, 404);
});

test('the owner or an admin can change the caption; others cannot', async (t) => {
  const ctx = await makeTestApp();
  t.after(ctx.cleanup);
  const owner = makeUser(ctx.db);
  const other = makeUser(ctx.db);
  const admin = makeUser(ctx.db, { role: 'admin' });
  const item = await addItem(ctx, owner, { caption: 'old' });
  const patch = (user, payload) =>
    ctx.app.inject({ method: 'PATCH', url: `/api/items/${item.id}`, headers: sameOrigin(loginAs(ctx.app, ctx.db, user)), payload });

  const mine = await patch(owner, { caption: '  New words  ' });
  assert.equal(mine.statusCode, 200);
  assert.equal(mine.json().item.caption, 'New words');
  assert.equal((await patch(admin, { caption: '' })).json().item.caption, null);
  const denied = await patch(other, { caption: 'hijack' });
  assert.equal(denied.statusCode, 403);
  assert.equal((await patch(owner, { caption: 'x'.repeat(501) })).statusCode, 400);
  assert.equal((await patch(owner, { caption: 42 })).statusCode, 400);
  assert.equal(ctx.db.prepare('SELECT caption FROM items WHERE id = ?').get(item.id).caption, null);
});

test('deleting removes the row, its files and its queued jobs, keeps Grandma\'s Feed, and tells everyone', async (t) => {
  const ctx = await makeTestApp();
  t.after(ctx.cleanup);
  const owner = makeUser(ctx.db);
  const other = makeUser(ctx.db);
  const device = makeDevice(ctx.db);
  const item = await addItem(ctx, owner);
  addReaction(ctx, item, device);
  enqueue(ctx.db, { kind: 'image', refId: item.id });
  const originalPath = ctx.app.storage.resolve(item.original_path);
  const before = ctx.db.prepare('SELECT COALESCE(MAX(id), 0) AS id FROM events').get().id;

  const denied = await ctx.app.inject({ method: 'DELETE', url: `/api/items/${item.id}`, headers: sameOrigin(loginAs(ctx.app, ctx.db, other)) });
  assert.equal(denied.statusCode, 403);

  const res = await ctx.app.inject({ method: 'DELETE', url: `/api/items/${item.id}`, headers: sameOrigin(loginAs(ctx.app, ctx.db, owner)) });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json(), { ok: true });
  assert.equal(ctx.db.prepare('SELECT COUNT(*) AS n FROM items').get().n, 0);
  assert.equal(ctx.db.prepare('SELECT COUNT(*) AS n FROM renditions').get().n, 0);
  assert.equal(ctx.db.prepare('SELECT COUNT(*) AS n FROM jobs').get().n, 0);
  const event = ctx.db.prepare('SELECT item_id FROM grandma_events').get();
  assert.equal(event.item_id, null, 'the reaction stays in the feed, unlinked');
  await assert.rejects(fs.access(originalPath));
  await assert.rejects(fs.access(ctx.app.storage.resolve(`renditions/${item.id}`)));
  const published = eventsAfter(ctx.db, before);
  assert.deepEqual(published.map((e) => [e.topic, e.payload]), [['item.removed', { item_id: item.id }]]);

  const again = await ctx.app.inject({ method: 'DELETE', url: `/api/items/${item.id}`, headers: sameOrigin(loginAs(ctx.app, ctx.db, owner)) });
  assert.equal(again.statusCode, 404);
});

test('an admin can delete anyone\'s item', async (t) => {
  const ctx = await makeTestApp();
  t.after(ctx.cleanup);
  const item = await addItem(ctx, makeUser(ctx.db));
  const admin = makeUser(ctx.db, { role: 'admin' });
  const res = await ctx.app.inject({ method: 'DELETE', url: `/api/items/${item.id}`, headers: sameOrigin(loginAs(ctx.app, ctx.db, admin)) });
  assert.equal(res.statusCode, 200);
});
