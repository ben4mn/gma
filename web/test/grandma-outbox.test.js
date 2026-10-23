import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createEntry, classify, due, markSending, applyResult, recover, summarize, RETRY_MS,
} from '../grandma/lib/outbox-core.js';
import { createOutbox, memoryStore } from '../grandma/lib/outbox.js';

const entry = (over = {}) => ({ ...createEntry({ kind: 'react', payload: { item_id: 'i1', reaction: 'love' }, clientId: 'c1', now: 100 }), ...over });

test('a new entry is pending and due at once', () => {
  const e = entry();
  assert.equal(e.status, 'pending');
  assert.equal(e.attempts, 0);
  assert.deepEqual(due([e], 100).map((x) => x.client_id), ['c1']);
});

test('classify: done, retry or failed', () => {
  for (const s of [200, 201, 204, 409]) assert.equal(classify(s), 'done', String(s));
  for (const s of [0, 401, 408, 429, 500, 502, 503]) assert.equal(classify(s), 'retry', String(s));
  for (const s of [400, 404, 410, 413, 422]) assert.equal(classify(s), 'failed', String(s));
});

test('success removes the entry; a retry waits for the next tick; a refusal is kept as failed', () => {
  const sending = markSending(entry(), 200);
  assert.equal(sending.status, 'sending');
  assert.equal(sending.attempts, 1);
  assert.equal(applyResult(sending, { status: 200 }, 300), null);
  const retry = applyResult(sending, { status: 0, error: 'offline' }, 300);
  assert.equal(retry.status, 'pending');
  assert.equal(retry.next_at, 300 + RETRY_MS);
  assert.equal(retry.last_error, 'offline');
  assert.deepEqual(due([retry], 301), []);
  assert.deepEqual(due([retry], 301, { force: true }).length, 1);
  const failed = applyResult(sending, { status: 404 }, 300);
  assert.equal(failed.status, 'failed');
  assert.equal(failed.last_error, 'HTTP 404');
  assert.deepEqual(due([failed], 10 ** 12, { force: true }), []);
});

test('entries caught mid-send go back to pending after a reload', () => {
  const list = [entry({ client_id: 'a', status: 'sending' }), entry({ client_id: 'b' }), entry({ client_id: 'c', status: 'failed' })];
  assert.deepEqual(recover(list).map((e) => [e.client_id, e.status]), [['a', 'pending']]);
  assert.deepEqual(summarize(list), { pending: 2, failed: 1 });
});

test('due() returns the oldest first', () => {
  const list = [entry({ client_id: 'new', created_at: 5 }), entry({ client_id: 'old', created_at: 1 })];
  assert.deepEqual(due(list, 1000).map((e) => e.client_id), ['old', 'new']);
});

function fakeClock(start = 1000) {
  let t = start;
  return { now: () => t, advance: (ms) => { t += ms; } };
}

test('the outbox sends, keeps what failed to reach the server, and resends with the same client_id', async () => {
  const clock = fakeClock();
  const store = memoryStore();
  const calls = [];
  let online = false;
  let n = 0;
  const outbox = createOutbox({
    store,
    now: clock.now,
    newId: () => `id-${++n}`,
    send: async (e) => { calls.push(e.client_id); return online ? { status: 200 } : { status: 0, error: 'Failed to fetch' }; },
  });
  await outbox.add('react', { item_id: 'i1', reaction: 'love' });
  await outbox.flush();
  assert.deepEqual(calls, ['id-1']);
  assert.equal((await store.getAll())[0].status, 'pending');
  assert.deepEqual(outbox.counts, { pending: 1, failed: 0 });

  online = true;
  await outbox.flush(); // not due yet: the retry clock hasn't come round
  assert.deepEqual(calls, ['id-1']);
  clock.advance(RETRY_MS);
  await outbox.flush();
  assert.deepEqual(calls, ['id-1', 'id-1']);
  assert.deepEqual(await store.getAll(), []);
  assert.deepEqual(outbox.counts, { pending: 0, failed: 0 });
});

test('a thrown send (no network at all) is a retry, never an exception', async () => {
  const store = memoryStore();
  const outbox = createOutbox({ store, newId: () => 'x', send: async () => { throw new TypeError('Failed to fetch'); } });
  await outbox.add('preset', { item_id: 'i', preset_id: 'p' });
  await outbox.flush({ force: true });
  const [e] = await store.getAll();
  assert.equal(e.status, 'pending');
  assert.equal(e.last_error, 'Failed to fetch');
});

test('seen marks are sent together in one request', async () => {
  const store = memoryStore();
  const sent = [];
  let n = 0;
  const outbox = createOutbox({ store, newId: () => `s${++n}`, send: async (e) => { sent.push(e); return { status: 200 }; } });
  await store.put(createEntry({ kind: 'seen', payload: { item_ids: ['a'] }, clientId: 's-a', now: 0 }));
  await store.put(createEntry({ kind: 'seen', payload: { item_ids: ['b', 'a'] }, clientId: 's-b', now: 0 }));
  await outbox.flush({ force: true });
  assert.equal(sent.length, 1);
  assert.deepEqual(sent[0].payload.item_ids, ['a', 'b']);
  assert.deepEqual(await store.getAll(), []);
});

test('something added during a flush is sent straight after it', async () => {
  const store = memoryStore();
  const sent = [];
  let n = 1; // c1 is put by hand below
  let release;
  const gate = new Promise((r) => { release = r; });
  const outbox = createOutbox({
    store,
    newId: () => `c${++n}`,
    send: async (e) => { sent.push(e.client_id); if (e.client_id === 'c1') await gate; return { status: 200 }; },
  });
  await store.put(createEntry({ kind: 'react', payload: {}, clientId: 'c1', now: 0 }));
  const first = outbox.flush({ force: true });
  await new Promise((r) => setTimeout(r, 5));
  await outbox.add('react', {}); // c2, while c1 is still in flight
  release();
  await first;
  await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual(sent, ['c1', 'c2']);
  assert.deepEqual(await store.getAll(), []);
});

test('a stalled voice upload never holds the reactions tapped after it (OPS-12)', { timeout: 5000 }, async () => {
  const store = memoryStore();
  const sent = [];
  let n = 0;
  let releaseVoice;
  const voiceGate = new Promise((r) => { releaseVoice = r; });
  const outbox = createOutbox({
    store,
    newId: () => `c${++n}`,
    send: async (e) => {
      sent.push(e.kind);
      if (e.kind === 'voice') { await voiceGate; return { status: 0, error: 'The operation timed out.' }; }
      return { status: 200 };
    },
  });
  await outbox.add('voice', { audio: 'blob' }); // c1: stalls on half-dead Wi-Fi
  await new Promise((r) => setTimeout(r, 5));
  await outbox.add('react', { item_id: 'i1', reaction: 'love' }); // c2
  await outbox.add('preset', { item_id: 'i1', preset_id: 'p1', preset_text: 'Love you' }); // c3
  await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual(sent, ['voice', 'react', 'preset']);
  assert.deepEqual((await store.getAll()).map((e) => e.client_id), ['c1'], 'the reaction and the message are already through');

  // a forced pass while the voice note is still on its way doesn't send it twice
  const pass = outbox.flush({ force: true });
  await new Promise((r) => setTimeout(r, 5));
  assert.deepEqual(sent, ['voice', 'react', 'preset']);
  releaseVoice();
  await pass;
  const [voice] = await store.getAll();
  assert.equal(voice.status, 'pending', 'a timeout is a retry');
  assert.equal(voice.last_error, 'The operation timed out.');
});
