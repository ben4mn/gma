import { test } from 'node:test';
import assert from 'node:assert/strict';
import { prefetchOptions } from '../app/passkeys.js';

const tick = () => new Promise((r) => setTimeout(r, 0));

test('take() hands out the options once and fetches nothing during the ceremony', async () => {
  let calls = 0;
  const ready = [];
  const prefetch = prefetchOptions(async () => ({ challenge: `c${++calls}` }), { onChange: (r) => ready.push(r) });
  await tick();
  assert.equal(calls, 1);
  assert.deepEqual(prefetch.take(), { challenge: 'c1' });
  await tick();
  // a second options call would replace the server's pending challenge mid-ceremony
  assert.equal(calls, 1);
  assert.equal(prefetch.take(), null, 'a taken challenge is never handed out twice');
  await tick();
  prefetch.stop();
  assert.equal(ready.at(-1), true, 'take() on empty starts a fetch and the button comes back');
});

test('refresh() after a failed ceremony gets a new challenge', async () => {
  let calls = 0;
  const prefetch = prefetchOptions(async () => ({ challenge: `c${++calls}` }));
  await tick();
  prefetch.take();
  await prefetch.refresh();
  assert.deepEqual(prefetch.take(), { challenge: 'c2' });
  prefetch.stop();
});
