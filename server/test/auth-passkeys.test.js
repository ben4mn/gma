// Passkeys end to end with a software authenticator: registration,
// usernameless sign-in, single-use challenges, the UV and origin checks,
// unknown credentials, removed people and the You screen's list.

import assert from 'node:assert/strict';
import { after, afterEach, before, describe, test } from 'node:test';
import { setClock } from '../src/lib/time.js';
import { loginAs, makeTestApp, makeUser, sameOrigin, TEST_ORIGIN } from './helpers/index.js';
import { createSoftAuthenticator } from './helpers/softAuthenticator.js';

// A browser's cookie jar, good enough for inject (paths are ignored).
function cookieJar(initial = '') {
  const jar = new Map();
  for (const pair of initial.split('; ').filter(Boolean)) {
    const at = pair.indexOf('=');
    jar.set(pair.slice(0, at), pair.slice(at + 1));
  }
  return {
    take(res) {
      for (const c of res.cookies) {
        const expired = c.value === '' || c.maxAge === 0 || (c.expires && c.expires.getTime() <= Date.now());
        if (expired) jar.delete(c.name);
        else jar.set(c.name, c.value);
      }
      return res;
    },
    get: (name) => jar.get(name),
    set: (name, value) => jar.set(name, value),
    header: () => [...jar].map(([k, v]) => `${k}=${v}`).join('; '),
  };
}

describe('passkeys', () => {
  let t;
  before(async () => {
    t = await makeTestApp();
  });
  after(async () => {
    await t.cleanup();
  });
  afterEach(() => setClock());

  async function post(jar, url, payload) {
    return jar.take(await t.app.inject({ method: 'POST', url, headers: sameOrigin(jar.header()), payload }));
  }

  // Signs `user` in, registers a passkey on `phone`, returns the jar.
  async function registerPasskey(user, phone) {
    const jar = cookieJar(loginAs(t.app, t.db, user));
    const options = (await post(jar, '/api/auth/passkey/register/options')).json();
    const res = await post(jar, '/api/auth/passkey/register/verify', phone.register(options));
    assert.equal(res.statusCode, 200, res.body);
    return jar;
  }

  async function signInWithPasskey(phone, jar = cookieJar()) {
    const options = (await post(jar, '/api/auth/passkey/login/options')).json();
    const res = await post(jar, '/api/auth/passkey/login/verify', phone.login(options));
    return { res, jar };
  }

  test('registration asks for a discoverable, user-verified passkey and stores it', async () => {
    const user = makeUser(t.db, { name: 'Sarah Lee' });
    const jar = cookieJar(loginAs(t.app, t.db, user));

    const optionsRes = await post(jar, '/api/auth/passkey/register/options');
    assert.equal(optionsRes.statusCode, 200);
    assert.equal(optionsRes.headers['cache-control'], 'no-store');
    const options = optionsRes.json();
    assert.equal(options.rp.id, 'localhost');
    assert.equal(options.rp.name, "Grandma's family");
    assert.equal(options.user.name, user.email);
    assert.equal(options.user.displayName, 'Sarah Lee');
    assert.equal(options.attestation, 'none');
    assert.equal(options.authenticatorSelection.residentKey, 'required');
    assert.equal(options.authenticatorSelection.requireResidentKey, true);
    assert.equal(options.authenticatorSelection.userVerification, 'required');
    assert.equal(options.timeout, 300_000);
    assert.deepEqual(options.excludeCredentials, []);
    assert.ok(jar.get('gma_webauthn'), 'the challenge is tied to this browser by a cookie');
    assert.ok(!jar.get('gma_webauthn').includes(options.challenge), 'the cookie is a reference, not the challenge');

    const phone = createSoftAuthenticator({ origin: TEST_ORIGIN });
    const res = await post(jar, '/api/auth/passkey/register/verify', phone.register(options));
    assert.equal(res.statusCode, 200, res.body);
    const body = res.json();
    assert.equal(body.passkeys, 1);
    assert.equal(body.passkey.id, phone.credentials[0].id);
    assert.equal(body.passkey.label, 'Apple Passwords');
    assert.equal(body.passkey.backed_up, true);
    assert.equal(body.passkey.device_type, 'multiDevice');
    assert.equal(jar.get('gma_passkey_offers'), 'done', 'this device is never offered a passkey again');

    const row = t.db.prepare('SELECT * FROM passkeys WHERE id = ?').get(body.passkey.id);
    assert.equal(row.user_id, user.id);
    assert.equal(row.counter, 0);
    assert.deepEqual(JSON.parse(row.transports), ['internal', 'hybrid']);
    assert.equal(t.db.prepare('SELECT COUNT(*) AS n FROM webauthn_challenges').get().n, 0, 'the challenge was used up');
  });

  test('a second registration excludes the passkeys the person already has', async () => {
    const user = makeUser(t.db);
    const phone = createSoftAuthenticator({ origin: TEST_ORIGIN });
    const jar = await registerPasskey(user, phone);

    const options = (await post(jar, '/api/auth/passkey/register/options')).json();
    assert.deepEqual(
      options.excludeCredentials.map((c) => c.id),
      [phone.credentials[0].id],
    );
    assert.throws(() => phone.register(options), { name: 'InvalidStateError' });

    // A second phone can still add one.
    const tablet = createSoftAuthenticator({ origin: TEST_ORIGIN });
    const res = await post(jar, '/api/auth/passkey/register/verify', tablet.register(options));
    assert.equal(res.statusCode, 200);
    assert.equal(res.json().passkeys, 2);
  });

  test('usernameless sign-in finds the person from the passkey alone', async () => {
    const user = makeUser(t.db);
    const phone = createSoftAuthenticator({ origin: TEST_ORIGIN });
    await registerPasskey(user, phone);

    const jar = cookieJar();
    const optionsRes = await post(jar, '/api/auth/passkey/login/options');
    assert.equal(optionsRes.statusCode, 200);
    const options = optionsRes.json();
    assert.deepEqual(options.allowCredentials, []);
    assert.equal(options.userVerification, 'required');
    assert.equal(options.rpId, 'localhost');

    const res = await post(jar, '/api/auth/passkey/login/verify', phone.login(options));
    assert.equal(res.statusCode, 200, res.body);
    assert.equal(res.json().user.id, user.id);
    assert.equal(res.json().offer_passkey, false);
    assert.ok(jar.get('gma_session'));
    assert.equal(jar.get('gma_passkey_offers'), 'done');

    const me = await t.app.inject({ url: '/api/me', headers: { cookie: jar.header() } });
    assert.equal(me.statusCode, 200);
    assert.equal(me.json().user.id, user.id);
    assert.equal(me.json().offer_passkey, false);

    const row = t.db.prepare('SELECT * FROM passkeys WHERE user_id = ?').get(user.id);
    assert.ok(row.last_used_at > 0);
    assert.equal(row.counter, 0, 'synced passkeys keep counter 0');

    // Counter 0 every time is fine (not treated as a cloned key).
    const again = await signInWithPasskey(phone);
    assert.equal(again.res.statusCode, 200);
  });

  test('a passkey that counts up (a security key) keeps working', async () => {
    const user = makeUser(t.db);
    const key = createSoftAuthenticator({ origin: TEST_ORIGIN, counterStep: 1, backedUp: false });
    await registerPasskey(user, key);
    for (let i = 0; i < 2; i++) assert.equal((await signInWithPasskey(key)).res.statusCode, 200);
    assert.equal(t.db.prepare('SELECT counter FROM passkeys WHERE user_id = ?').get(user.id).counter, 2);
  });

  test('a challenge works once: replaying an answer fails', async () => {
    const user = makeUser(t.db);
    const phone = createSoftAuthenticator({ origin: TEST_ORIGIN });
    await registerPasskey(user, phone);

    const jar = cookieJar();
    const options = (await post(jar, '/api/auth/passkey/login/options')).json();
    const cookie = jar.get('gma_webauthn');
    const assertion = phone.login(options);
    assert.equal((await post(jar, '/api/auth/passkey/login/verify', assertion)).statusCode, 200);

    // Same answer, same pre-auth cookie: the challenge row is gone.
    const replay = cookieJar(`gma_webauthn=${cookie}`);
    const res = await post(replay, '/api/auth/passkey/login/verify', assertion);
    assert.equal(res.statusCode, 400);
    assert.equal(res.json().error.code, 'passkey_failed');
    assert.equal(res.json().error.message, "That didn't work. Try again or get an email code.");

    // Same answer against a fresh challenge: it signed the old one.
    const fresh = cookieJar();
    await post(fresh, '/api/auth/passkey/login/options');
    assert.equal((await post(fresh, '/api/auth/passkey/login/verify', assertion)).statusCode, 400);
  });

  test('a challenge expires after 5 minutes', async () => {
    const user = makeUser(t.db);
    const phone = createSoftAuthenticator({ origin: TEST_ORIGIN });
    await registerPasskey(user, phone);

    const jar = cookieJar();
    const options = (await post(jar, '/api/auth/passkey/login/options')).json();
    const later = Date.now() + 5 * 60 * 1000 + 1000;
    setClock(() => later);
    const res = await post(jar, '/api/auth/passkey/login/verify', phone.login(options));
    assert.equal(res.statusCode, 400);
    assert.equal(res.json().error.code, 'passkey_failed');
  });

  test('without the pre-auth cookie, or with a forged one, nothing verifies', async () => {
    const user = makeUser(t.db);
    const phone = createSoftAuthenticator({ origin: TEST_ORIGIN });
    await registerPasskey(user, phone);

    const jar = cookieJar();
    const options = (await post(jar, '/api/auth/passkey/login/options')).json();
    const [id] = jar.get('gma_webauthn').split('.');
    const assertion = phone.login(options);

    const noCookie = await post(cookieJar(), '/api/auth/passkey/login/verify', assertion);
    assert.equal(noCookie.statusCode, 400);
    const forged = await post(cookieJar(`gma_webauthn=${id}.${'0'.repeat(32)}`), '/api/auth/passkey/login/verify', assertion);
    assert.equal(forged.statusCode, 400);
    // The forged attempt didn't use the real challenge up.
    assert.equal((await post(jar, '/api/auth/passkey/login/verify', assertion)).statusCode, 200);
  });

  test('user verification is required: no UV flag, no passkey', async () => {
    const user = makeUser(t.db);
    const jar = cookieJar(loginAs(t.app, t.db, user));
    const noUv = createSoftAuthenticator({ origin: TEST_ORIGIN, userVerified: false });
    const options = (await post(jar, '/api/auth/passkey/register/options')).json();
    const res = await post(jar, '/api/auth/passkey/register/verify', noUv.register(options));
    assert.equal(res.statusCode, 400);
    assert.equal(res.json().error.code, 'passkey_failed');
    assert.equal(t.db.prepare('SELECT COUNT(*) AS n FROM passkeys WHERE user_id = ?').get(user.id).n, 0);

    // A registered passkey whose sign-in skips UV is refused too.
    const phone = createSoftAuthenticator({ origin: TEST_ORIGIN });
    await registerPasskey(user, phone);
    phone.settings.userVerified = false;
    assert.equal((await signInWithPasskey(phone)).res.statusCode, 400);
  });

  test('the origin must be PUBLIC_URL', async () => {
    const user = makeUser(t.db);
    const jar = cookieJar(loginAs(t.app, t.db, user));
    const phishing = createSoftAuthenticator({ origin: 'https://gma-4mn.example' });
    const options = (await post(jar, '/api/auth/passkey/register/options')).json();
    assert.equal((await post(jar, '/api/auth/passkey/register/verify', phishing.register(options))).statusCode, 400);

    const phone = createSoftAuthenticator({ origin: TEST_ORIGIN });
    await registerPasskey(user, phone);
    phone.settings.origin = 'https://gma-4mn.example';
    assert.equal((await signInWithPasskey(phone)).res.statusCode, 400);
  });

  test('registering needs a session, and a challenge made for someone else is refused', async () => {
    const signedOut = await t.app.inject({ method: 'POST', url: '/api/auth/passkey/register/options', headers: sameOrigin() });
    assert.equal(signedOut.statusCode, 401);

    const alice = makeUser(t.db);
    const bob = makeUser(t.db);
    const aliceJar = cookieJar(loginAs(t.app, t.db, alice));
    const options = (await post(aliceJar, '/api/auth/passkey/register/options')).json();
    const bobJar = cookieJar(loginAs(t.app, t.db, bob));
    bobJar.set('gma_webauthn', aliceJar.get('gma_webauthn'));
    const phone = createSoftAuthenticator({ origin: TEST_ORIGIN });
    const res = await post(bobJar, '/api/auth/passkey/register/verify', phone.register(options));
    assert.equal(res.statusCode, 400);
    assert.equal(t.db.prepare('SELECT COUNT(*) AS n FROM passkeys WHERE user_id IN (?, ?)').get(alice.id, bob.id).n, 0);
  });

  test('a deleted passkey is an unknown credential, so the app can switch to a code', async () => {
    const user = makeUser(t.db);
    const phone = createSoftAuthenticator({ origin: TEST_ORIGIN });
    const jar = await registerPasskey(user, phone);
    const id = phone.credentials[0].id;

    const del = await t.app.inject({ method: 'DELETE', url: `/api/me/passkeys/${id}`, headers: sameOrigin(jar.header()) });
    assert.equal(del.statusCode, 200);
    assert.deepEqual(del.json(), { ok: true, passkeys: 0 });

    const { res } = await signInWithPasskey(phone);
    assert.equal(res.statusCode, 404);
    assert.equal(res.json().error.code, 'unknown_credential');
  });

  test('a removed person cannot sign in with a passkey, and their sessions stop working', async () => {
    const user = makeUser(t.db);
    const phone = createSoftAuthenticator({ origin: TEST_ORIGIN });
    const jar = await registerPasskey(user, phone);
    t.db.prepare("UPDATE users SET status = 'removed', removed_at = ? WHERE id = ?").run(Date.now(), user.id);

    const { res, jar: newJar } = await signInWithPasskey(phone);
    assert.equal(res.statusCode, 404);
    assert.equal(res.json().error.code, 'unknown_credential');
    assert.equal(newJar.get('gma_session'), undefined);
    const me = await t.app.inject({ url: '/api/me', headers: { cookie: jar.header() } });
    assert.equal(me.statusCode, 401);
  });

  test('the You screen lists passkeys and can only remove your own', async () => {
    const user = makeUser(t.db);
    const phone = createSoftAuthenticator({ origin: TEST_ORIGIN });
    const jar = await registerPasskey(user, phone);
    const regOptions = (await post(jar, '/api/auth/passkey/register/options')).json();

    const list = await t.app.inject({ url: '/api/me/passkeys', headers: { cookie: jar.header() } });
    assert.equal(list.statusCode, 200);
    const body = list.json();
    assert.equal(body.passkeys.length, 1);
    assert.deepEqual(Object.keys(body.passkeys[0]).sort(), [
      'backed_up',
      'created_at',
      'device_type',
      'id',
      'label',
      'last_used_at',
    ]);
    assert.equal(body.rp_id, 'localhost');
    assert.equal(body.user_handle, regOptions.user.id, 'the handle signalAllAcceptedCredentials needs');

    const other = makeUser(t.db);
    const otherCookie = loginAs(t.app, t.db, other);
    const del = await t.app.inject({
      method: 'DELETE',
      url: `/api/me/passkeys/${phone.credentials[0].id}`,
      headers: sameOrigin(otherCookie),
    });
    assert.equal(del.statusCode, 404);
    assert.equal(t.db.prepare('SELECT COUNT(*) AS n FROM passkeys WHERE user_id = ?').get(user.id).n, 1);
  });

  test('a sign-in answer from another site is refused', async () => {
    const jar = cookieJar();
    await post(jar, '/api/auth/passkey/login/options');
    const res = await t.app.inject({
      method: 'POST',
      url: '/api/auth/passkey/login/verify',
      headers: { origin: 'https://evil.example', cookie: jar.header() },
      payload: {},
    });
    assert.equal(res.statusCode, 403);
    assert.equal(res.json().error.code, 'bad_origin');
  });
});
