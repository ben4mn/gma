import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { makeTestApp, makeUser, makeDevice, loginAs, loginAsDevice } from './helpers/index.js';
import { newId } from '../src/lib/ids.js';

const BYTES = Buffer.from('0123456789abcdefghijklmnopqrstuvwxyz');

async function addVideoItem(ctx, user, status = 'ready') {
  const id = newId();
  ctx.db
    .prepare(`INSERT INTO items (id, user_id, kind, status, original_path, created_at, ready_at) VALUES (?, ?, 'video', ?, ?, ?, ?)`)
    .run(id, user.id, status, `originals/2026/10/${id}.mov`, Date.now(), Date.now());
  const key = ctx.app.storage.renditionKey(id, 'video', 'mp4');
  await fs.writeFile(await ctx.app.storage.ensureDirFor(key), BYTES);
  ctx.db.prepare("INSERT INTO renditions (item_id, name, path, mime, bytes) VALUES (?, 'video', ?, 'video/mp4', ?)").run(id, key, BYTES.length);
  return id;
}

test('renditions are served with immutable private caching and Range support', async (t) => {
  const ctx = await makeTestApp();
  t.after(ctx.cleanup);
  const user = makeUser(ctx.db);
  const cookie = loginAs(ctx.app, ctx.db, user);
  const id = await addVideoItem(ctx, user);

  const whole = await ctx.app.inject({ url: `/media/${id}/video?v=1`, headers: { cookie } });
  assert.equal(whole.statusCode, 200);
  assert.equal(whole.headers['content-type'], 'video/mp4');
  assert.equal(whole.headers['cache-control'], 'private, max-age=31536000, immutable');
  assert.equal(whole.headers['accept-ranges'], 'bytes');
  assert.ok(whole.rawPayload.equals(BYTES));

  const part = await ctx.app.inject({ url: `/media/${id}/video?v=1`, headers: { cookie, range: 'bytes=10-19' } });
  assert.equal(part.statusCode, 206);
  assert.equal(part.headers['content-range'], `bytes 10-19/${BYTES.length}`);
  assert.equal(part.body, 'abcdefghij');

  const tail = await ctx.app.inject({ url: `/media/${id}/video`, headers: { cookie, range: 'bytes=-6' } });
  assert.equal(tail.statusCode, 206);
  assert.equal(tail.body, 'uvwxyz');

  const beyond = await ctx.app.inject({ url: `/media/${id}/video`, headers: { cookie, range: 'bytes=999-' } });
  assert.equal(beyond.statusCode, 416);
});

test('a paired frame sees ready items only; signed-out visitors see nothing', async (t) => {
  const ctx = await makeTestApp();
  t.after(ctx.cleanup);
  const owner = makeUser(ctx.db);
  const ready = await addVideoItem(ctx, owner);
  const processing = await addVideoItem(ctx, owner, 'processing');
  const frame = loginAsDevice(ctx.app, ctx.db, makeDevice(ctx.db));

  assert.equal((await ctx.app.inject({ url: `/media/${ready}/video`, headers: { cookie: frame } })).statusCode, 200);
  assert.equal((await ctx.app.inject({ url: `/media/${processing}/video`, headers: { cookie: frame } })).statusCode, 404);
  assert.equal((await ctx.app.inject({ url: `/media/${ready}/video` })).statusCode, 401);

  const revoked = makeDevice(ctx.db, { revoked_at: Date.now() });
  assert.equal((await ctx.app.inject({ url: `/media/${ready}/video`, headers: { cookie: loginAsDevice(ctx.app, ctx.db, revoked) } })).statusCode, 401);
});

test('hidden and unfinished items are only for the owner and admins', async (t) => {
  const ctx = await makeTestApp();
  t.after(ctx.cleanup);
  const owner = makeUser(ctx.db);
  const hidden = await addVideoItem(ctx, owner, 'hidden');
  const get = (user) => ctx.app.inject({ url: `/media/${hidden}/video`, headers: { cookie: loginAs(ctx.app, ctx.db, user) } });
  assert.equal((await get(makeUser(ctx.db))).statusCode, 404);
  assert.equal((await get(owner)).statusCode, 200);
  assert.equal((await get(makeUser(ctx.db, { role: 'admin' }))).statusCode, 200);
});

test('unknown renditions, bad ids and originals are never served', async (t) => {
  const ctx = await makeTestApp();
  t.after(ctx.cleanup);
  const user = makeUser(ctx.db);
  const cookie = loginAs(ctx.app, ctx.db, user);
  const id = await addVideoItem(ctx, user);
  for (const url of [`/media/${id}/original`, `/media/${id}/display`, '/media/..%2F..%2Fetc/passwd', `/media/${id}/..%2Fvideo`, '/media/originals/2026']) {
    const res = await ctx.app.inject({ url, headers: { cookie } });
    assert.equal(res.statusCode, 404, url);
  }
  // The row exists but the file is gone: a clean 404, not a crash.
  await fs.rm(ctx.app.storage.resolve(`renditions/${id}/video.mp4`));
  assert.equal((await ctx.app.inject({ url: `/media/${id}/video`, headers: { cookie } })).statusCode, 404);
});

test('voice notes play for the family and the frame once they are ready', async (t) => {
  const ctx = await makeTestApp();
  t.after(ctx.cleanup);
  const device = makeDevice(ctx.db);
  const id = newId();
  const key = ctx.app.storage.renditionKey(id, 'audio', 'm4a');
  await fs.writeFile(await ctx.app.storage.ensureDirFor(key), BYTES);
  ctx.db
    .prepare("INSERT INTO voice_notes (id, device_id, status, audio_path, created_at) VALUES (?, ?, 'ready', ?, ?)")
    .run(id, device.id, key, Date.now());
  const pending = newId();
  ctx.db.prepare("INSERT INTO voice_notes (id, device_id, status, created_at) VALUES (?, ?, 'processing', ?)").run(pending, device.id, Date.now());

  const res = await ctx.app.inject({ url: `/media/voice/${id}`, headers: { cookie: loginAs(ctx.app, ctx.db, makeUser(ctx.db)) } });
  assert.equal(res.statusCode, 200);
  assert.equal(res.headers['content-type'], 'audio/mp4');
  assert.equal((await ctx.app.inject({ url: `/media/voice/${id}`, headers: { cookie: loginAsDevice(ctx.app, ctx.db, device) } })).statusCode, 200);
  assert.equal((await ctx.app.inject({ url: `/media/voice/${pending}`, headers: { cookie: loginAsDevice(ctx.app, ctx.db, device) } })).statusCode, 404);
  assert.equal((await ctx.app.inject({ url: `/media/voice/${id}` })).statusCode, 401);
});
