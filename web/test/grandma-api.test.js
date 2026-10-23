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
