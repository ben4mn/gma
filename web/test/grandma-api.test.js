// The frame's API client: what each outbox entry posts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApi } from '../grandma/lib/api.js';

function withFetch(fn) {
  const calls = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    calls.push({ url, body: init?.body ? JSON.parse(init.body) : null });
    return new Response('{}', { status: 200 });
  };
  return fn(calls).finally(() => { globalThis.fetch = original; });
}

test('a queued preset carries its text, so one Ben deletes later still arrives (F14)', () => withFetch(async (calls) => {
  const api = createApi();
  await api.send({ kind: 'preset', client_id: 'c1', payload: { item_id: 'i1', preset_id: 'p1', preset_text: 'Proud of you' } });
  assert.deepEqual(calls[0], {
    url: '/api/frame/preset',
    body: { item_id: 'i1', preset_id: 'p1', client_id: 'c1', preset_text: 'Proud of you' },
  });
  // entries queued before this change had no text: they still send
  await api.send({ kind: 'preset', client_id: 'c2', payload: { item_id: 'i1', preset_id: 'p1' } });
  assert.deepEqual(calls[1].body, { item_id: 'i1', preset_id: 'p1', client_id: 'c2' });
}));

// A fetch that never answers until it is aborted, like a request on half-dead Wi-Fi.
function withStalledFetch(fn) {
  const original = globalThis.fetch;
  const seen = [];
  globalThis.fetch = (url, init) => new Promise((_, reject) => {
    seen.push({ url, timedOut: false });
    init?.signal?.addEventListener('abort', () => reject(init.signal.reason ?? new Error('aborted')));
  });
  return fn(seen).finally(() => { globalThis.fetch = original; });
}

test('a stalled request gives up after its timeout and counts as "no answer" (OPS-12)', { timeout: 3000 }, () => withStalledFetch(async () => {
  const api = createApi({ timeouts: { json: 40, voice: 80 } });
  const started = Date.now();
  const react = await api.send({ kind: 'react', client_id: 'c1', payload: { item_id: 'i1', reaction: 'love' } });
  assert.equal(react.status, 0);
  const form = { audio: new Blob(['x']), filename: 'v.webm' };
  const voice = await api.send({ kind: 'voice', client_id: 'c2', payload: form });
  assert.equal(voice.status, 0);
  const beat = await api.heartbeat({ version: 'v' });
  assert.equal(beat.status, 0);
  assert.ok(Date.now() - started < 1500);
}));

test('the frame waits 20 s for a reaction and 2 minutes for a voice note by default', async () => {
  const { REQUEST_TIMEOUTS } = await import('../grandma/lib/api.js');
  assert.deepEqual(REQUEST_TIMEOUTS, { json: 20_000, voice: 120_000 });
});
