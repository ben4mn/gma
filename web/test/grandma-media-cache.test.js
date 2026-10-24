import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mediaKind, planEvictions, parseRange, rangeResponse } from '../grandma/lib/media-cache.js';

test('mediaKind picks out display/poster images and videos', () => {
  assert.equal(mediaKind('/media/01ABC/display'), 'image');
  assert.equal(mediaKind('/media/01ABC/poster'), 'image');
  assert.equal(mediaKind('/media/01ABC/video'), 'video');
  assert.equal(mediaKind('/media/01ABC/thumb'), null);
  assert.equal(mediaKind('/media/voice/01ABC'), null);
  assert.equal(mediaKind('/api/frame/state'), null);
});

test('planEvictions keeps the 300 most recently used images', () => {
  const index = Array.from({ length: 305 }, (_, i) => ({ url: `/media/${i}/display`, kind: 'image', bytes: 1, used_at: i }));
  const evict = planEvictions(index);
  assert.equal(evict.length, 5);
  assert.deepEqual(evict.sort(), ['/media/0/display', '/media/1/display', '/media/2/display', '/media/3/display', '/media/4/display']);
});

test('planEvictions keeps videos under the byte budget, newest first', () => {
  const MB = 1024 * 1024;
  const index = [
    { url: 'a', kind: 'video', bytes: 200 * MB, used_at: 3 },
    { url: 'b', kind: 'video', bytes: 200 * MB, used_at: 2 },
    { url: 'c', kind: 'video', bytes: 200 * MB, used_at: 1 },
  ];
  assert.deepEqual(planEvictions(index), ['c']);
  assert.deepEqual(planEvictions(index, { maxImages: 300, maxVideoBytes: 100 * MB }), ['a', 'b', 'c']);
});

test('parseRange handles open, closed and suffix ranges', () => {
  assert.deepEqual(parseRange('bytes=0-', 1000), { start: 0, end: 999 });
  assert.deepEqual(parseRange('bytes=100-199', 1000), { start: 100, end: 199 });
  assert.deepEqual(parseRange('bytes=900-5000', 1000), { start: 900, end: 999 });
  assert.deepEqual(parseRange('bytes=-100', 1000), { start: 900, end: 999 });
  assert.equal(parseRange('bytes=1000-', 1000), null);
  assert.equal(parseRange('bytes=5-2', 1000), null);
  assert.equal(parseRange('items=0-1', 1000), null);
  assert.equal(parseRange('bytes=-', 1000), null);
});

test('rangeResponse answers a Range request from a whole cached file', async () => {
  const full = new Response(new Blob([new Uint8Array(1000).map((_, i) => i % 256)]), { headers: { 'Content-Type': 'video/mp4' } });
  const res = await rangeResponse(full, 'bytes=10-19');
  assert.equal(res.status, 206);
  assert.equal(res.headers.get('Content-Range'), 'bytes 10-19/1000');
  assert.equal(res.headers.get('Content-Length'), '10');
  assert.deepEqual([...new Uint8Array(await res.arrayBuffer())], [10, 11, 12, 13, 14, 15, 16, 17, 18, 19]);
  const bad = await rangeResponse(new Response(new Blob(['abc'])), 'bytes=10-');
  assert.equal(bad.status, 416);
});
