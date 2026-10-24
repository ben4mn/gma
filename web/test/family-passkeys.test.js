import { test } from 'node:test';
import assert from 'node:assert/strict';
import { prefetchOptions, platformPasskeysAvailable, isAlreadyRegistered, registrationFailure, PASSKEY_IOS_HELP, PASSKEY_RETRY } from '../app/passkeys.js';

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

test('the offer only appears where the phone can make a passkey (F9)', async () => {
  assert.equal(await platformPasskeysAvailable({ isUserVerifyingPlatformAuthenticatorAvailable: async () => true }), true);
  assert.equal(await platformPasskeysAvailable({ isUserVerifyingPlatformAuthenticatorAvailable: async () => false }), false);
  assert.equal(await platformPasskeysAvailable({ isUserVerifyingPlatformAuthenticatorAvailable: async () => { throw new Error('x'); } }), false);
  assert.equal(await platformPasskeysAvailable(undefined), false);
});

test('a phone that already has the passkey counts as set up; failures explain and stop after two (F8, F9)', () => {
  assert.equal(isAlreadyRegistered({ name: 'InvalidStateError' }), true);
  assert.equal(isAlreadyRegistered({ code: 'ERROR_AUTHENTICATOR_PREVIOUSLY_REGISTERED' }), true);
  assert.equal(isAlreadyRegistered({ name: 'NotAllowedError' }), false);
  assert.deepEqual(registrationFailure({ os: 'ios', failures: 1 }), { message: PASSKEY_IOS_HELP, canRetry: true });
  assert.deepEqual(registrationFailure({ os: 'android', failures: 2 }), { message: PASSKEY_RETRY, canRetry: false });
  assert.match(PASSKEY_IOS_HELP, /iCloud Keychain/);
});
