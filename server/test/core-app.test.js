// Core: buildApp's wiring: headers, the Origin check, errors, guards, rate
// limits, pages and /healthz.

import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { buildApp } from '../src/app.js';
import { requireAdmin, requireDevice, requireUser, requireUserOrDevice, httpError } from '../src/lib/guards.js';
import { setSetting } from '../src/lib/settings.js';
import { createSession } from '../src/lib/sessions.js';
import {
  loginAs,
  loginAsDevice,
  makeDevice,
  makeTempDir,
  makeTestApp,
  makeTestConfig,
  makeUser,
  makeWebFixture,
  sameOrigin,
  TEST_ORIGIN,
} from './helpers/index.js';

// Throwaway routes registered through buildApp's `plugins` option.
async function testRoutes(app) {
  const who = async (request) => ({ user: request.user?.id ?? null, device: request.device?.id ?? null });
  app.get('/t/user', { preHandler: requireUser }, who);
  app.get('/t/admin', { preHandler: requireAdmin }, who);
  app.get('/t/device', { preHandler: requireDevice }, who);
  app.get('/t/either', { preHandler: requireUserOrDevice }, who);
  app.post('/t/echo', async (request) => ({ got: request.body }));
  app.get('/t/http-error', async () => {
    throw httpError(409, 'already_sent', 'Grandma already sent that one.');
  });
  app.get('/t/plain-error', async () => {
    throw Object.assign(new Error('That photo is gone.'), { statusCode: 404, code: 'item_gone' });
  });
  app.get('/t/crash', async () => {
    throw new Error('database exploded at /data/gma.sqlite');
  });
  app.post(
    '/t/validated',
    { schema: { body: { type: 'object', required: ['name'], properties: { name: { type: 'string' } } } } },
    async () => ({ ok: true }),
  );
  app.post('/t/limited', { config: { rateLimit: { max: 1, timeWindow: '1 minute' } } }, async () => ({ ok: true }));
}

describe('app', () => {
  let t;
  before(async () => {
    t = await makeTestApp({ plugins: [testRoutes] });
  });
  after(async () => {
    await t.cleanup();
  });

  test('every response carries the security headers, errors included', async () => {
    for (const url of ['/healthz', '/does-not-exist', '/t/crash']) {
      const res = await t.app.inject({ url });
      assert.match(res.headers['content-security-policy'], /default-src 'self'/);
      assert.match(res.headers['content-security-policy'], /img-src 'self' blob: data:/);
      assert.match(res.headers['content-security-policy'], /media-src 'self' blob:/);
      assert.doesNotMatch(res.headers['content-security-policy'], /unsafe-inline/);
      assert.equal(res.headers['x-robots-tag'], 'noindex, nofollow');
      assert.equal(res.headers['referrer-policy'], 'no-referrer');
      assert.equal(res.headers['permissions-policy'], 'microphone=(self), camera=()');
      assert.equal(res.headers['x-content-type-options'], 'nosniff');
    }
  });

  test('state-changing requests need the app origin', async () => {
    const ok = await t.app.inject({ method: 'POST', url: '/t/echo', headers: sameOrigin(), payload: { a: 1 } });
    assert.equal(ok.statusCode, 200);
    assert.deepEqual(ok.json(), { got: { a: 1 } });

    const noOrigin = await t.app.inject({ method: 'POST', url: '/t/echo', payload: { a: 1 } });
    assert.equal(noOrigin.statusCode, 200, 'tests may inject without an Origin');

    for (const origin of ['https://evil.example', 'http://localhost:8081', 'null']) {
      const res = await t.app.inject({ method: 'POST', url: '/t/echo', headers: { origin }, payload: {} });
      assert.equal(res.statusCode, 403, origin);
      assert.equal(res.json().error.code, 'bad_origin');
    }
    for (const method of ['PUT', 'PATCH', 'DELETE']) {
      const res = await t.app.inject({ method, url: '/t/echo', headers: { origin: 'https://evil.example' } });
      assert.equal(res.statusCode, 403, method);
    }
    const get = await t.app.inject({ url: '/healthz', headers: { origin: 'https://evil.example' } });
    assert.equal(get.statusCode, 200, 'reads are not origin-checked');
  });

  test('JSON bodies only', async () => {
    const res = await t.app.inject({
      method: 'POST',
      url: '/t/echo',
      headers: sameOrigin(null, { 'content-type': 'text/plain' }),
      payload: 'hello',
    });
    assert.equal(res.statusCode, 415);
    assert.equal(res.json().error.code, 'unsupported_media_type');
  });

  test('errors are { error: { code, message } } and never leak internals', async () => {
    const conflict = await t.app.inject({ url: '/t/http-error' });
    assert.equal(conflict.statusCode, 409);
    assert.deepEqual(conflict.json(), { error: { code: 'already_sent', message: 'Grandma already sent that one.' } });

    const gone = await t.app.inject({ url: '/t/plain-error' });
    assert.equal(gone.statusCode, 404);
    assert.deepEqual(gone.json(), { error: { code: 'item_gone', message: 'That photo is gone.' } });

    const crash = await t.app.inject({ url: '/t/crash' });
    assert.equal(crash.statusCode, 500);
    assert.equal(crash.json().error.code, 'server_error');
    assert.doesNotMatch(crash.body, /exploded|gma\.sqlite/);

    const invalid = await t.app.inject({ method: 'POST', url: '/t/validated', payload: {} });
    assert.equal(invalid.statusCode, 400);
    assert.equal(invalid.json().error.code, 'bad_request');

    const malformed = await t.app.inject({
      method: 'POST',
      url: '/t/echo',
      headers: { 'content-type': 'application/json' },
      payload: '{not json',
    });
    assert.equal(malformed.statusCode, 400);
    assert.ok(malformed.json().error.message);

    const missing = await t.app.inject({ url: '/api/nothing-here' });
    assert.deepEqual(missing.json(), { error: { code: 'not_found', message: "We couldn't find that." } });
  });

  test('guards set request.user / request.device and refuse everyone else', async () => {
    const member = makeUser(t.db);
    const admin = makeUser(t.db, { role: 'admin' });
    const device = makeDevice(t.db);
    const memberCookie = loginAs(t.app, t.db, member);
    const adminCookie = loginAs(t.app, t.db, admin);
    const deviceCookie = loginAsDevice(t.app, t.db, device);
    const get = (url, cookie) => t.app.inject({ url, headers: cookie ? { cookie } : {} });

    assert.deepEqual((await get('/t/user', memberCookie)).json(), { user: member.id, device: null });
    assert.equal((await get('/t/user')).statusCode, 401);
    assert.equal((await get('/t/user')).json().error.code, 'unauthorized');
    assert.equal((await get('/t/user', deviceCookie)).statusCode, 401);
    assert.equal((await get('/t/user', 'gma_session=not-a-real-token-at-all')).statusCode, 401);

    assert.equal((await get('/t/admin', memberCookie)).statusCode, 403);
    assert.equal((await get('/t/admin')).statusCode, 401);
    assert.equal((await get('/t/admin', adminCookie)).statusCode, 200);

    assert.deepEqual((await get('/t/device', deviceCookie)).json(), { user: null, device: device.id });
    assert.equal((await get('/t/device', memberCookie)).statusCode, 401);

    assert.equal((await get('/t/either', memberCookie)).statusCode, 200);
    assert.equal((await get('/t/either', deviceCookie)).statusCode, 200);
    assert.equal((await get('/t/either')).statusCode, 401);

    t.db.prepare("UPDATE users SET status = 'removed' WHERE id = ?").run(member.id);
    assert.equal((await get('/t/user', memberCookie)).statusCode, 401, 'removed people are signed out');
    t.db.prepare('UPDATE devices SET revoked_at = ? WHERE id = ?').run(Date.now(), device.id);
    assert.equal((await get('/t/device', deviceCookie)).statusCode, 401, 'revoked frames are signed out');
  });

  test('a sliding renewal sets the cookie again with the 400-day lifetime', async () => {
    const user = makeUser(t.db);
    const { token, id } = createSession(t.db, { kind: 'user', userId: user.id });
    t.db.prepare('UPDATE sessions SET expires_at = ? WHERE id = ?').run(Date.now() + 86_400_000, id);
    const res = await t.app.inject({ url: '/t/user', headers: { cookie: `gma_session=${token}` } });
    assert.equal(res.statusCode, 200);
    const cookie = res.cookies.find((c) => c.name === 'gma_session');
    assert.equal(cookie.value, token);
    assert.equal(cookie.maxAge, 34_560_000);
    assert.equal(cookie.httpOnly, true);
    assert.equal(cookie.sameSite, 'Lax');
    assert.equal(cookie.path, '/');

    const quiet = await t.app.inject({ url: '/t/user', headers: { cookie: `gma_session=${token}` } });
    assert.equal(quiet.cookies.length, 0, 'no cookie when nothing changed');
  });

  test('routes can opt in to rate limits, which answer in the same error shape', async () => {
    const first = await t.app.inject({ method: 'POST', url: '/t/limited', payload: {} });
    assert.equal(first.statusCode, 200);
    const second = await t.app.inject({ method: 'POST', url: '/t/limited', payload: {} });
    assert.equal(second.statusCode, 429);
    assert.equal(second.json().error.code, 'rate_limited');
    assert.match(second.json().error.message, /wait/);
  });

  test('/healthz reports the database and the worker heartbeat', async () => {
    const before = await t.app.inject({ url: '/healthz' });
    assert.deepEqual(before.json(), { ok: true, db: true, worker_last_seen: null });
    assert.equal(before.headers['cache-control'], 'no-store');
    setSetting(t.db, 'worker_last_seen', 1_792_627_200_000);
    const after = await t.app.inject({ url: '/healthz' });
    assert.equal(after.json().worker_last_seen, 1_792_627_200_000);
  });
});

describe('the Origin check outside tests', () => {
  test('a request with no Origin is refused unless it is a test injection', async () => {
    const dir = await makeTempDir();
    const config = makeTestConfig(dir, { NODE_ENV: 'development' });
    const app = await buildApp(config, { plugins: [testRoutes] });
    try {
      const res = await app.inject({ method: 'POST', url: '/t/echo', payload: {} });
      assert.equal(res.statusCode, 403);
      const ok = await app.inject({ method: 'POST', url: '/t/echo', headers: { origin: TEST_ORIGIN }, payload: {} });
      assert.equal(ok.statusCode, 200);
    } finally {
      await app.close();
    }
  });

  test('a real socket with no Origin is refused even in test mode', async () => {
    const t = await makeTestApp({ plugins: [testRoutes] });
    try {
      const address = await t.app.listen({ host: '127.0.0.1', port: 0 });
      const res = await fetch(`${address}/t/echo`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      });
      assert.equal(res.status, 403);
    } finally {
      await t.cleanup();
    }
  });
});

describe('pages', () => {
  let t;
  let member;
  let admin;
  let device;
  before(async () => {
    const dir = await makeTempDir();
    const webDir = await makeWebFixture(dir);
    t = await makeTestApp({ env: { WEB_DIR: webDir } });
    member = loginAs(t.app, t.db, makeUser(t.db));
    admin = loginAs(t.app, t.db, makeUser(t.db, { role: 'admin' }));
    device = loginAsDevice(t.app, t.db, makeDevice(t.db));
  });
  after(async () => {
    await t.cleanup();
  });
  const get = (url, cookie) => t.app.inject({ url, headers: cookie ? { cookie } : {} });

  test('private family pages send signed-out visitors to /signin', async () => {
    for (const url of ['/', '/from-grandma', '/mine', '/upload', '/you', '/admin', '/admin/people']) {
      const res = await get(url);
      assert.equal(res.statusCode, 302, url);
      assert.equal(res.headers.location, `/signin?next=${encodeURIComponent(url)}`);
    }
  });

  test('signed in, every family page is the shell, revalidated on each load', async () => {
    for (const url of ['/', '/from-grandma', '/mine', '/upload', '/you']) {
      const res = await get(url, member);
      assert.equal(res.statusCode, 200, url);
      assert.match(res.body, /family shell/);
      assert.match(res.headers['content-type'], /text\/html/);
      assert.equal(res.headers['cache-control'], 'no-cache');
    }
  });

  test('sign-in pages are public', async () => {
    for (const url of ['/signin', '/confirm?t=abc', '/join/some-token']) {
      const res = await get(url);
      assert.equal(res.statusCode, 200, url);
      assert.match(res.body, /family shell/);
    }
  });

  test('admin pages are for admins', async () => {
    assert.equal((await get('/admin', member)).headers.location, '/');
    assert.match((await get('/admin', admin)).body, /family shell/);
    assert.match((await get('/admin/devices', admin)).body, /family shell/);
  });

  test('/grandma/ is the frame, for a paired frame or an admin', async () => {
    const frame = await get('/grandma/', device);
    assert.equal(frame.statusCode, 200);
    assert.match(frame.body, /frame shell/);
    assert.equal(frame.headers['cache-control'], 'no-cache');
    assert.match((await get('/grandma/', admin)).body, /frame shell/);
    assert.equal((await get('/grandma/', member)).statusCode, 302);
    assert.equal((await get('/grandma/')).statusCode, 302);
    const pairing = await get('/grandma');
    assert.notEqual(pairing.statusCode, 200, 'the pairing route (routes/frame.js) never serves the shell without a token');
    assert.doesNotMatch(pairing.body, /frame shell/);
    const leak = await get('/grandma/?device=SECRET-TOKEN');
    assert.equal(leak.headers.location, '/signin?next=%2Fgrandma%2F', 'tokens never ride along in next');
  });

  test('static files: assets cached for a year, code revalidated, dotfiles hidden', async () => {
    const asset = await get('/assets/mark.svg');
    assert.equal(asset.statusCode, 200);
    assert.equal(asset.headers['cache-control'], 'public, max-age=31536000, immutable');
    const code = await get('/app/main.js');
    assert.equal(code.statusCode, 200);
    assert.match(code.headers['content-type'], /javascript/);
    assert.equal(code.headers['cache-control'], 'no-cache');
    assert.equal((await get('/.secret')).statusCode, 404);
    assert.equal((await get('/assets/../../etc/passwd')).statusCode, 404);
  });

  test('the frame’s service worker may control /grandma, the pairing link; nothing else widens a scope', async () => {
    const worker = await get('/grandma/sw.js', device);
    assert.equal(worker.statusCode, 200);
    assert.equal(worker.headers['service-worker-allowed'], '/grandma');
    assert.equal(worker.headers['cache-control'], 'no-cache');
    assert.equal((await get('/app/main.js')).headers['service-worker-allowed'], undefined);
    assert.equal((await get('/grandma/index.html', device)).headers['service-worker-allowed'], undefined);
  });

  test('robots.txt disallows everything', async () => {
    const res = await get('/robots.txt');
    assert.equal(res.statusCode, 200);
    assert.equal(res.body, 'User-agent: *\nDisallow: /\n');
  });
});
