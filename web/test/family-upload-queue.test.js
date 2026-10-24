import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createQueue, reduce, nextToStart, summary, kindOf, rejectReason, entryLabel } from '../app/upload-queue.js';

const files = [
  { name: 'IMG_1.HEIC', type: '', size: 4_000_000 },
  { name: 'clip.mov', type: 'video/quicktime', size: 96_000_000 },
];

test('kindOf and rejectReason', () => {
  assert.equal(kindOf(files[0]), 'photo');
  assert.equal(kindOf(files[1]), 'video');
  assert.equal(kindOf({ name: 'notes.pdf', type: 'application/pdf' }), null);
  assert.match(rejectReason({ name: 'notes.pdf', type: 'application/pdf', size: 10 }), /isn’t a photo or a video/);
  assert.match(rejectReason({ name: 'big.mov', type: 'video/quicktime', size: 3 * 1024 ** 3 }), /too big/);
  assert.equal(rejectReason(files[0]), null);
});

test('one at a time, with progress, success and the summary', () => {
  let q = createQueue(files, { batchId: 'B' });
  assert.deepEqual(nextToStart(q), ['f0']);
  q = reduce(q, { type: 'start', id: 'f0' });
  assert.deepEqual(nextToStart(q), []);
  q = reduce(q, { type: 'progress', id: 'f0', sent: 2_000_000, total: 4_000_000 });
  assert.equal(entryLabel(q.entries[0]), 'Sending… 50%');
  q = reduce(q, { type: 'success', id: 'f0' });
  assert.deepEqual(nextToStart(q), ['f1']);
  const s = summary(q);
  assert.equal(s.done, 1);
  assert.equal(s.finished, false);
  assert.equal(s.percent, 4);
});

test('offline pauses, online resumes, failure can be retried', () => {
  let q = createQueue(files);
  q = reduce(q, { type: 'start', id: 'f0' });
  q = reduce(q, { type: 'offline' });
  assert.equal(q.entries[0].status, 'paused');
  assert.deepEqual(nextToStart(q), []);
  assert.match(entryLabel(q.entries[0]), /carries on by itself/);
  q = reduce(q, { type: 'online' });
  assert.equal(q.entries[0].status, 'uploading');
  q = reduce(q, { type: 'fail', id: 'f0', message: 'The server said no.' });
  assert.equal(entryLabel(q.entries[0]), 'The server said no.');
  assert.deepEqual(nextToStart(q), ['f1']);
  q = reduce(q, { type: 'retry', id: 'f0' });
  assert.equal(q.entries[0].status, 'queued');
});

test('finished and allSent', () => {
  let q = createQueue(files);
  q = reduce(q, { type: 'success', id: 'f0' });
  q = reduce(q, { type: 'fail', id: 'f1' });
  assert.deepEqual([summary(q).finished, summary(q).allSent], [true, false]);
});
