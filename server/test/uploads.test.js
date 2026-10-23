import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { makeTestApp, makeUser, loginAs, sameOrigin, makeTempDir } from './helpers/index.js';
import { makeJpeg } from './fixtures/images.js';
import { normaliseMetadata, sweepScratch } from '../src/routes/uploads.js';

const TUS = { 'tus-resumable': '1.0.0' };

function encodeMetadata(meta) {
  return Object.entries(meta)
    .map(([key, value]) => `${key} ${Buffer.from(String(value)).toString('base64')}`)
    .join(',');
}

async function create(app, cookie, { length, metadata = {}, headers = {} }) {
  return app.inject({
    method: 'POST',
    url: '/api/uploads/',
    headers: {
      ...sameOrigin(cookie),
      ...TUS,
      'upload-length': String(length),
      ...(Object.keys(metadata).length ? { 'upload-metadata': encodeMetadata(metadata) } : {}),
      ...headers,
    },
  });
}

async function patch(app, cookie, location, body, offset = 0) {
  return app.inject({
    method: 'PATCH',
    url: location,
    headers: { ...sameOrigin(cookie), ...TUS, 'upload-offset': String(offset), 'content-type': 'application/offset+octet-stream' },
    payload: body,
  });
}

async function uploadWhole(app, cookie, body, metadata) {
  const created = await create(app, cookie, { length: body.length, metadata });
  assert.equal(created.statusCode, 201, created.body);
  return patch(app, cookie, created.headers.location, body);
}

test('a finished upload becomes a processing item with a job, and the original moves out of scratch', async (t) => {
  const ctx = await makeTestApp();
  t.after(ctx.cleanup);
  const user = makeUser(ctx.db);
  const cookie = loginAs(ctx.app, ctx.db, user);
  const photo = await makeJpeg();

  const created = await create(ctx.app, cookie, {
    length: photo.length,
    metadata: { filename: 'IMG_0001.HEIC', filetype: 'image/jpeg', caption: '  Lily at the farm  ', batch_id: 'b_123' },
  });
  assert.equal(created.statusCode, 201, created.body);
  assert.match(created.headers.location, /^\/api\/uploads\/[A-Za-z0-9_-]+$/);

  const half = Math.floor(photo.length / 2);
  const first = await patch(ctx.app, cookie, created.headers.location, photo.subarray(0, half));
  assert.equal(first.statusCode, 204);
  assert.equal(first.headers['upload-offset'], String(half));

  const head = await ctx.app.inject({ method: 'HEAD', url: created.headers.location, headers: { cookie, ...TUS } });
  assert.equal(head.statusCode, 200);
  assert.equal(head.headers['upload-offset'], String(half));

  const last = await patch(ctx.app, cookie, created.headers.location, photo.subarray(half), half);
  assert.equal(last.statusCode, 204, last.body);
  const itemId = last.headers['x-item-id'];
  assert.ok(itemId, 'the response names the new item');

  const item = ctx.db.prepare('SELECT * FROM items WHERE id = ?').get(itemId);
  assert.equal(item.user_id, user.id);
  assert.equal(item.kind, 'photo');
  assert.equal(item.status, 'processing');
  assert.equal(item.caption, 'Lily at the farm');
  assert.equal(item.batch_id, 'b_123');
  assert.equal(item.original_mime, 'image/jpeg', 'sniffed, not taken from the filename');
  assert.equal(item.original_bytes, photo.length);
  assert.match(item.original_path, new RegExp(`^originals/\\d{4}/\\d{2}/${itemId}\\.jpg$`));
  const stored = await fs.readFile(ctx.app.storage.resolve(item.original_path));
  assert.ok(stored.equals(photo));

  const job = ctx.db.prepare('SELECT * FROM jobs WHERE ref_id = ?').get(itemId);
  assert.equal(job.kind, 'image');
  assert.equal(job.status, 'queued');

  assert.deepEqual(await fs.readdir(ctx.app.storage.uploadsDir), [], 'scratch is empty');
});

test('the owner comes from the session, not from the metadata', async (t) => {
  const ctx = await makeTestApp();
  t.after(ctx.cleanup);
  const user = makeUser(ctx.db);
  const other = makeUser(ctx.db);
  const cookie = loginAs(ctx.app, ctx.db, user);
  const photo = await makeJpeg();
  const res = await uploadWhole(ctx.app, cookie, photo, { filetype: 'image/jpeg', user_id: other.id });
  assert.equal(res.statusCode, 204);
  assert.equal(ctx.db.prepare('SELECT user_id FROM items WHERE id = ?').get(res.headers['x-item-id']).user_id, user.id);
});

test('uploads larger than the JSON body limit go through', async (t) => {
  const ctx = await makeTestApp();
  t.after(ctx.cleanup);
  const cookie = loginAs(ctx.app, ctx.db, makeUser(ctx.db));
  const photo = await makeJpeg();
  const big = Buffer.concat([photo, Buffer.alloc(1.5 * 1024 * 1024)]); // JPEG decoders ignore trailing bytes
  const res = await uploadWhole(ctx.app, cookie, big, { filetype: 'image/jpeg' });
  assert.equal(res.statusCode, 204, res.body);
});

test('only the person who started an upload can continue, check or cancel it', async (t) => {
  const ctx = await makeTestApp();
  t.after(ctx.cleanup);
  const owner = loginAs(ctx.app, ctx.db, makeUser(ctx.db));
  const stranger = loginAs(ctx.app, ctx.db, makeUser(ctx.db));
  const photo = await makeJpeg();
  const created = await create(ctx.app, owner, { length: photo.length, metadata: { filetype: 'image/jpeg' } });
  const loc = created.headers.location;

  const head = await ctx.app.inject({ method: 'HEAD', url: loc, headers: { cookie: stranger, ...TUS } });
  assert.equal(head.statusCode, 404);
  const write = await patch(ctx.app, stranger, loc, photo);
  assert.equal(write.statusCode, 404);
  const del = await ctx.app.inject({ method: 'DELETE', url: loc, headers: { ...sameOrigin(stranger), ...TUS } });
  assert.equal(del.statusCode, 404);
  assert.equal(ctx.db.prepare('SELECT COUNT(*) AS n FROM items').get().n, 0);

  const mine = await ctx.app.inject({ method: 'DELETE', url: loc, headers: { ...sameOrigin(owner), ...TUS } });
  assert.equal(mine.statusCode, 204);
});

test('signed-out and cross-site requests are refused', async (t) => {
  const ctx = await makeTestApp();
  t.after(ctx.cleanup);
  const signedOut = await create(ctx.app, null, { length: 10 });
  assert.equal(signedOut.statusCode, 401);
  assert.equal(signedOut.json().error.code, 'unauthorized');

  const cookie = loginAs(ctx.app, ctx.db, makeUser(ctx.db));
  const crossSite = await create(ctx.app, cookie, { length: 10, headers: { origin: 'https://evil.example' } });
  assert.equal(crossSite.statusCode, 403);

  const removed = makeUser(ctx.db, { status: 'removed' });
  const gone = await create(ctx.app, loginAs(ctx.app, ctx.db, removed), { length: 10 });
  assert.equal(gone.statusCode, 401);
});

test('files that are not photos or videos are turned away kindly', async (t) => {
  const ctx = await makeTestApp();
  t.after(ctx.cleanup);
  const cookie = loginAs(ctx.app, ctx.db, makeUser(ctx.db));

  const declared = await create(ctx.app, cookie, { length: 10, metadata: { filetype: 'application/pdf' } });
  assert.equal(declared.statusCode, 415);
  assert.match(declared.body, /photo or a video/);

  // Claims to be a photo but the bytes say otherwise.
  const text = Buffer.from('just some words, definitely not a photo');
  const sneaky = await uploadWhole(ctx.app, cookie, text, { filetype: 'image/jpeg' });
  assert.equal(sneaky.statusCode, 415);
  assert.equal(ctx.db.prepare('SELECT COUNT(*) AS n FROM items').get().n, 0);
  assert.deepEqual(await fs.readdir(ctx.app.storage.uploadsDir), []);
});

test('a too-long caption and a too-big file are refused at the start', async (t) => {
  const ctx = await makeTestApp({ env: { MAX_UPLOAD_BYTES: '1000' } });
  t.after(ctx.cleanup);
  const cookie = loginAs(ctx.app, ctx.db, makeUser(ctx.db));
  const caption = await create(ctx.app, cookie, { length: 10, metadata: { caption: 'x'.repeat(501) } });
  assert.equal(caption.statusCode, 400);
  assert.match(caption.body, /caption is too long/);
  const big = await create(ctx.app, cookie, { length: 1001 });
  assert.equal(big.statusCode, 413);
});

test('a video upload queues a video job', async (t) => {
  const ctx = await makeTestApp();
  t.after(ctx.cleanup);
  const cookie = loginAs(ctx.app, ctx.db, makeUser(ctx.db));
  // The start of a QuickTime file: an ftyp box with the 'qt  ' brand.
  const mov = Buffer.concat([Buffer.from([0, 0, 0, 20]), Buffer.from('ftypqt  \0\0\0\0qt  '), Buffer.alloc(100)]);
  const res = await uploadWhole(ctx.app, cookie, mov, { filetype: 'video/quicktime' });
  assert.equal(res.statusCode, 204, res.body);
  const item = ctx.db.prepare('SELECT * FROM items WHERE id = ?').get(res.headers['x-item-id']);
  assert.equal(item.kind, 'video');
  assert.equal(item.original_mime, 'video/quicktime');
  assert.equal(ctx.db.prepare('SELECT kind FROM jobs WHERE ref_id = ?').get(item.id).kind, 'video');
});

test('normaliseMetadata keeps only what it trusts', () => {
  assert.deepEqual(normaliseMetadata({ filename: 'a.jpg', filetype: 'image/jpeg', caption: ' hi ', batch_id: 'ok_1', user_id: 'x' }, 'U1'), {
    user_id: 'U1',
    filename: 'a.jpg',
    filetype: 'image/jpeg',
    caption: 'hi',
    batch_id: 'ok_1',
  });
  assert.deepEqual(normaliseMetadata({ batch_id: '../../etc', caption: '   ' }, 'U1'), { user_id: 'U1' });
  assert.throws(() => normaliseMetadata({ filetype: 'text/html' }, 'U1'), (err) => err.status_code === 415);
});

test('sweepScratch removes week-old chunks only', async (t) => {
  const dir = await makeTempDir();
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  await fs.writeFile(path.join(dir, 'old'), 'x');
  await fs.writeFile(path.join(dir, 'new'), 'x');
  const weekAgo = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
  await fs.utimes(path.join(dir, 'old'), weekAgo, weekAgo);
  assert.equal(await sweepScratch(dir), 1);
  assert.deepEqual(await fs.readdir(dir), ['new']);
});
