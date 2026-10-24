// Fixes from a probe of the live site (gma.4mn.org behind the tunnel):
// plain-http visits forwarded by Cloudflare go to https, Cloudflare may not
// rewrite the pages (no-transform), the frame's page is never a static file,
// the "not set up" page is styled for the kiosk, the hourly limits say an
// hour, ?next= stays on this site, and code requests answer before any work.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { rateLimitedMessage } from '../src/app.js';
import { compileTrust, forwardedProto, fromTrustedProxy } from '../src/lib/client-ip.js';
import { NOT_SET_UP_STYLESHEET } from '../src/routes/frame.js';
import { safeNextPath } from '../src/routes/pages.js';
import {
  loginAs,
  loginAsDevice,
  makeDevice,
  makeTempDir,
  makeTestApp,
  makeUser,
  makeWebFixture,
  sameOrigin,
} from './helpers/index.js';

const REPO = fileURLToPath(new URL('../../', import.meta.url));
const TUNNEL = '10.35.0.3';
const PUBLIC = 'https://gma.example.org';
const REVALIDATE = 'no-cache, no-transform';

// One turn of the event loop: work queued with setImmediate has run.
const settle = () => new Promise((resolve) => setImmediate(resolve));

async function testRoutes(app) {
  app.get('/t/ok', async () => ({ ok: true }));
  app.post('/t/echo', async (request) => ({ got: request.body }));
  app.post('/t/hourly', { config: { rateLimit: { max: 1, timeWindow: '1 hour' } } }, async () => ({ ok: true }));
  app.post('/t/short', { config: { rateLimit: { max: 1, timeWindow: '15 minutes' } } }, async () => ({ ok: true }));
}

describe('plain http through the tunnel goes to https', () => {
  let t;
  before(async () => {
    const dir = await makeTempDir();
    const webDir = await makeWebFixture(dir);
    t = await makeTestApp({ env: { PUBLIC_URL: PUBLIC, TRUST_PROXY: TUNNEL, WEB_DIR: webDir }, plugins: [testRoutes] });
  });
  after(async () => {
    await t.cleanup();
  });

  const viaTunnel = (method, url, proto, extra = {}) =>
    t.app.inject({
      method,
      url,
      remoteAddress: TUNNEL,
      headers: { 'x-forwarded-proto': proto, 'cf-connecting-ip': '203.0.113.7', origin: PUBLIC, ...extra },
      ...(method === 'POST' ? { payload: {} } : {}),
    });

  test('GET and HEAD get a 301 to the same path and query on the https origin', async () => {
    for (const url of ['/', '/signin?next=%2Fmine', '/grandma?device=abc', '/healthz', '/app/main.js']) {
      for (const method of ['GET', 'HEAD']) {
        const res = await viaTunnel(method, url, 'http');
        assert.equal(res.statusCode, 301, `${method} ${url}`);
        assert.equal(res.headers.location, `${PUBLIC}${url}`, `${method} ${url}`);
      }
    }
    const listed = await viaTunnel('GET', '/mine?x=1', 'HTTP, https');
    assert.equal(listed.headers.location, `${PUBLIC}/mine?x=1`, 'the first entry is the visitor’s');
  });

  test('a redirect never leaves the site, whatever the request target says', async () => {
    const res = await viaTunnel('GET', '//evil.example/x', 'http');
    assert.equal(res.statusCode, 301);
    assert.equal(new URL(res.headers.location).origin, PUBLIC);
  });

  test('other methods are refused with the JSON error, nothing is done', async () => {
    const res = await viaTunnel('POST', '/t/echo', 'http');
    assert.equal(res.statusCode, 400);
    assert.equal(res.json().error.code, 'https_required');
    assert.match(res.json().error.message, /https:\/\/gma\.example\.org/);
    assert.equal(res.headers.location, undefined);
  });

  test('https through the tunnel is served as before', async () => {
    assert.equal((await viaTunnel('GET', '/t/ok', 'https')).statusCode, 200);
    assert.equal((await viaTunnel('POST', '/t/echo', 'https')).statusCode, 200);
  });

  test('nothing that skipped the trusted proxy is redirected (local, the debug port)', async () => {
    // The debug port (127.0.0.1:3064 → app:8080) arrives from the bridge, not the tunnel.
    for (const remoteAddress of ['10.35.0.1', '127.0.0.1']) {
      const res = await t.app.inject({ url: '/t/ok', remoteAddress, headers: { 'x-forwarded-proto': 'http' } });
      assert.equal(res.statusCode, 200, remoteAddress);
    }
    const noHeader = await t.app.inject({ url: '/t/ok', remoteAddress: TUNNEL });
    assert.equal(noHeader.statusCode, 200, 'no header, no redirect');
  });

  test('forwardedProto believes only a trusted proxy', () => {
    const trust = compileTrust([TUNNEL]);
    const req = (peer, proto) => ({ headers: { 'x-forwarded-proto': proto }, raw: { socket: { remoteAddress: peer } } });
    assert.equal(forwardedProto(req(TUNNEL, 'http'), trust), 'http');
    assert.equal(forwardedProto(req(`::ffff:${TUNNEL}`, 'https'), trust), 'https');
    assert.equal(forwardedProto(req('10.35.0.9', 'http'), trust), null);
    assert.equal(forwardedProto(req(TUNNEL, 'gopher'), trust), null);
    assert.equal(fromTrustedProxy(req(TUNNEL, 'http'), trust), true);
  });
});

describe('an http PUBLIC_URL (development) never redirects', () => {
  test('even a trusted proxy saying http', async () => {
    const t = await makeTestApp({ env: { TRUST_PROXY: '127.0.0.1' }, plugins: [testRoutes] });
    try {
      const res = await t.app.inject({ url: '/t/ok', remoteAddress: '127.0.0.1', headers: { 'x-forwarded-proto': 'http' } });
      assert.equal(res.statusCode, 200);
    } finally {
      await t.cleanup();
    }
  });
});

describe('Cloudflare may not rewrite the pages (no-transform)', () => {
  let t;
  let member;
  let device;
  before(async () => {
    const dir = await makeTempDir();
    const webDir = await makeWebFixture(dir);
    fs.writeFileSync(path.join(webDir, 'manifest.webmanifest'), '{}');
    fs.writeFileSync(path.join(webDir, 'sw.js'), '// the family worker\n');
    fs.mkdirSync(path.join(webDir, 'vendor'));
    fs.writeFileSync(path.join(webDir, 'vendor', 'lib.js'), 'export {};\n');
    fs.writeFileSync(path.join(webDir, 'grandma', 'grandma.css'), 'body{}');
    t = await makeTestApp({ env: { WEB_DIR: webDir } });
    member = loginAs(t.app, t.db, makeUser(t.db));
    device = loginAsDevice(t.app, t.db, makeDevice(t.db));
  });
  after(async () => {
    await t.cleanup();
  });
  const get = (url, cookie) => t.app.inject({ url, headers: cookie ? { cookie } : {} });

  test('every HTML page is no-cache, no-transform', async () => {
    for (const [url, cookie] of [['/signin'], ['/', member], ['/mine', member], ['/grandma/', device], ['/index.html']]) {
      const res = await get(url, cookie);
      assert.equal(res.statusCode, 200, url);
      assert.match(res.headers['content-type'], /text\/html/, url);
      assert.equal(res.headers['cache-control'], REVALIDATE, url);
    }
  });

  test('JS, CSS, the manifest and the workers are revalidated but still compressible (no no-transform); /assets stays immutable', async () => {
    for (const [url, cookie] of [['/app/main.js'], ['/sw.js'], ['/manifest.webmanifest'], ['/grandma/sw.js', device], ['/grandma/grandma.css']]) {
      const res = await get(url, cookie);
      assert.equal(res.statusCode, 200, url);
      assert.equal(res.headers['cache-control'], 'no-cache', url);
    }
    assert.equal((await get('/assets/mark.svg')).headers['cache-control'], 'public, max-age=31536000, immutable');
    assert.equal((await get('/vendor/lib.js')).headers['cache-control'], 'public, max-age=2592000');
  });
});

describe('the frame’s page is never a static file', () => {
  let t;
  let member;
  let admin;
  let device;
  before(async () => {
    const dir = await makeTempDir();
    const webDir = await makeWebFixture(dir);
    for (const name of ['grandma.js', 'grandma.css', 'version.js', 'not-set-up.css']) {
      fs.writeFileSync(path.join(webDir, 'grandma', name), `/* ${name} */\n`);
    }
    t = await makeTestApp({ env: { WEB_DIR: webDir } });
    member = loginAs(t.app, t.db, makeUser(t.db));
    admin = loginAs(t.app, t.db, makeUser(t.db, { role: 'admin' }));
    device = loginAsDevice(t.app, t.db, makeDevice(t.db));
  });
  after(async () => {
    await t.cleanup();
  });
  const get = (url, cookie) => t.app.inject({ url, headers: cookie ? { cookie } : {} });

  test('/grandma/index.html needs a paired frame or an admin, like /grandma/', async () => {
    for (const cookie of [undefined, member]) {
      const res = await get('/grandma/index.html', cookie);
      assert.notEqual(res.statusCode, 200);
      assert.doesNotMatch(res.body, /frame shell/);
    }
    assert.equal((await get('/grandma/index.html')).headers.location, '/signin?next=%2Fgrandma%2Findex.html');
    for (const cookie of [device, admin]) {
      const res = await get('/grandma/index.html', cookie);
      assert.equal(res.statusCode, 200);
      assert.match(res.body, /frame shell/);
      assert.equal(res.headers['cache-control'], REVALIDATE);
    }
  });

  test('no other spelling of the path gets the shell from the static handler', async () => {
    for (const url of [
      '/grandma//index.html',
      '/grandma/./index.html',
      '/grandma/%69ndex.html',
      '/grandma/lib/../index.html',
      '/grandma/INDEX.html',
      '/grandma/index.html/',
      '/grandma/index.html?x=1',
    ]) {
      const res = await get(url, member);
      assert.doesNotMatch(res.body, /frame shell/, url);
      assert.notEqual(res.statusCode, 200, url);
    }
  });

  test('the frame’s own files stay public: it needs them before and after pairing', async () => {
    for (const url of ['/grandma/sw.js', '/grandma/grandma.js', '/grandma/grandma.css', '/grandma/version.js', '/grandma/not-set-up.css']) {
      const res = await get(url);
      assert.equal(res.statusCode, 200, url);
    }
  });

  test('/index.html is only the family shell, the same file anyone gets at /signin', async () => {
    const res = await get('/index.html');
    assert.equal(res.statusCode, 200);
    assert.equal(res.body, (await get('/signin')).body);
    assert.doesNotMatch(res.body, /frame shell/);
  });
});

describe('the "not set up" page on the kiosk', () => {
  let t;
  before(async () => {
    t = await makeTestApp();
  });
  after(async () => {
    await t.cleanup();
  });

  test('403, no-store, no-transform, no cookie, styled from a file in Heirloom', async () => {
    const res = await t.app.inject({ url: '/grandma?device=not-a-real-token-at-all-xxxxxxxx' });
    assert.equal(res.statusCode, 403);
    assert.equal(res.headers['cache-control'], 'no-store, no-transform');
    assert.equal(res.cookies.length, 0);
    assert.match(res.body, /This frame isn.t set up yet\./);
    assert.match(res.body, /Ben can fix this\./);
    assert.ok(res.body.includes(`<link rel="stylesheet" href="${NOT_SET_UP_STYLESHEET}">`));
    assert.doesNotMatch(res.body, /<style|style=|<script|onclick|<button|<a\s|<form|<input/i, 'nothing inline, nothing to tap');
  });

  test('the stylesheet is served from /grandma/ without a session, in Heirloom’s colours and large type', async () => {
    const res = await t.app.inject({ url: NOT_SET_UP_STYLESHEET });
    assert.equal(res.statusCode, 200);
    assert.match(res.headers['content-type'], /text\/css/);
    const css = fs.readFileSync(path.join(REPO, 'web', NOT_SET_UP_STYLESHEET), 'utf8');
    assert.equal(res.body, css);
    for (const colour of ['#F5EEE2', '#2B2119', '#57473A', '#FFFDF8']) assert.ok(css.includes(colour), colour);
    assert.match(css, /Fraunces/);
    assert.match(css, /Atkinson Hyperlegible Next/);
    const sizes = [...css.matchAll(/font-size:\s*(\d+)px/g)].map((m) => Number(m[1]));
    assert.ok(sizes.length >= 2 && Math.min(...sizes) >= 32, `large text only (got ${sizes})`);
    assert.doesNotMatch(css, /@import|url\((?!"\/assets\/)/, 'nothing from outside the site');
  });
});

describe('429 messages say how long', () => {
  let t;
  before(async () => {
    t = await makeTestApp({ plugins: [testRoutes] });
  });
  after(async () => {
    await t.cleanup();
  });

  test('an hourly limiter says an hour; a short one a few minutes', async () => {
    const hit = async (url) => {
      await t.app.inject({ method: 'POST', url, payload: {}, remoteAddress: '192.0.2.40' });
      return t.app.inject({ method: 'POST', url, payload: {}, remoteAddress: '192.0.2.40' });
    };
    const hourly = await hit('/t/hourly');
    assert.equal(hourly.statusCode, 429);
    assert.equal(hourly.json().error.code, 'rate_limited');
    assert.equal(hourly.json().error.message, 'Too many tries. Please wait an hour and try again.');
    const short = await hit('/t/short');
    assert.equal(short.statusCode, 429);
    assert.equal(short.json().error.message, 'Too many tries. Please wait a few minutes and try again.');
  });

  test('worded from the time the limiter has left', () => {
    assert.match(rateLimitedMessage(59 * 60_000), /an hour/);
    assert.match(rateLimitedMessage(15 * 60_000), /a few minutes/);
    assert.match(rateLimitedMessage(4 * 60_000), /a few minutes/);
    assert.match(rateLimitedMessage(undefined), /a few minutes/);
  });

  test('the real hourly limits: code requests, invite accepts', async () => {
    const ip = '192.0.2.41';
    let res;
    for (let i = 0; i < 21; i++) {
      res = await t.app.inject({
        method: 'POST',
        url: '/api/auth/code/request',
        headers: sameOrigin(''),
        payload: { email: `nobody${i}@example.com` },
        remoteAddress: ip,
      });
    }
    assert.equal(res.statusCode, 429);
    assert.match(res.json().error.message, /wait an hour/);

    for (let i = 0; i < 21; i++) {
      res = await t.app.inject({
        method: 'POST',
        url: '/api/invites/not-a-real-invite-token-xxxxxxxx/accept',
        headers: sameOrigin(''),
        payload: { name: 'Someone' },
        remoteAddress: ip,
      });
    }
    assert.equal(res.statusCode, 429);
    assert.match(res.json().error.message, /wait an hour/);
  });
});

describe('?next= after signing in stays on this site', () => {
  test('safeNextPath keeps same-origin paths and sends everything else home', () => {
    const origin = 'https://gma.example.org';
    assert.equal(safeNextPath('/mine?x=1#top', origin), '/mine?x=1#top');
    assert.equal(safeNextPath('/admin/people', origin), '/admin/people');
    assert.equal(safeNextPath(`${origin}/you`, origin), '/you');
    for (const bad of ['/x/..//evil.example', '/%2e%2e//evil.example', '/.//evil.example', '/x/../\\evil.example', '//evil.example', '/\\evil.example', '\\\\evil.example', 'https://evil.example/', 'javascript:alert(1)', '', null, undefined, 42]) {
      assert.equal(safeNextPath(bad, origin), '/', String(bad));
    }
  });

  // A real socket: app.inject and fetch would tidy the dot segments away first.
  const rawGet = (address, rawPath) =>
    new Promise((resolve, reject) => {
      const { hostname, port } = new URL(address);
      http
        .get({ hostname, port, path: rawPath }, (res) => {
          res.resume();
          res.on('end', () => resolve({ statusCode: res.statusCode, location: res.headers.location }));
        })
        .on('error', reject);
    });

  test('the sign-in redirect never writes a next that leaves the site', async () => {
    const dir = await makeTempDir();
    const webDir = await makeWebFixture(dir);
    const t = await makeTestApp({ env: { WEB_DIR: webDir } });
    try {
      const address = await t.app.listen({ host: '127.0.0.1', port: 0 });
      for (const url of ['/admin/..//evil.example', '/admin/%2e%2e//evil.example', '/admin/../\\evil.example']) {
        const res = await rawGet(address, url);
        assert.equal(res.statusCode, 302, url);
        const next = new URL(res.location, t.config.publicOrigin).searchParams.get('next');
        assert.equal(new URL(next, t.config.publicOrigin).origin, t.config.publicOrigin, `${url} → ${next}`);
      }
      const res = await t.app.inject({ url: '/mine?tab=2' });
      assert.equal(res.headers.location, '/signin?next=%2Fmine%3Ftab%3D2');
    } finally {
      await t.cleanup();
    }
  });
});

describe('a code request answers before any work on the address', () => {
  let t;
  before(async () => {
    t = await makeTestApp();
  });
  after(async () => {
    await t.cleanup();
  });

  const request = (email, remoteAddress) =>
    t.app.inject({ method: 'POST', url: '/api/auth/code/request', headers: sameOrigin(''), payload: { email }, remoteAddress });

  test('real and unknown addresses get the same 200 before anything is looked up or sent', async () => {
    const user = makeUser(t.db);
    const codes = () => t.db.prepare('SELECT COUNT(*) AS n FROM login_codes WHERE user_id = ?').get(user.id).n;
    const mailed = t.mail.length;

    const real = await request(user.email, '192.0.2.50');
    assert.equal(real.statusCode, 200);
    assert.deepEqual(real.json(), { ok: true });
    assert.equal(codes(), 0, 'no code made before the answer');
    assert.equal(t.mail.length, mailed, 'nothing sent before the answer');

    const unknown = await request('nobody-at-all@example.com', '192.0.2.51');
    assert.equal(unknown.statusCode, 200);
    assert.equal(unknown.body, real.body);

    await settle();
    assert.equal(codes(), 1, 'the code is made after the answer');
    assert.equal(t.mail.length, mailed + 1, 'and only the real person is mailed');
    assert.equal(t.mail.at(-1).to, user.email);
  });

  test('a bad address is still refused at once', async () => {
    const res = await request('not an email', '192.0.2.52');
    assert.equal(res.statusCode, 400);
    assert.equal(res.json().error.code, 'invalid_email');
  });
});
