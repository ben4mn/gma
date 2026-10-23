import { test } from 'node:test';
import assert from 'node:assert/strict';
import { matchRoute, normalizePath, isAppLink, safeNext } from '../app/router.js';

test('every family page in the contract has a route', () => {
  for (const [path, name] of [
    ['/', 'family'], ['/from-grandma', 'grandma'], ['/mine', 'mine'], ['/upload', 'upload'],
    ['/signin', 'signin'], ['/confirm', 'confirm'], ['/you', 'you'], ['/admin', 'admin'], ['/admin/frame', 'admin'],
  ]) assert.equal(matchRoute(path)?.route.name, name, path);
});

test('params are decoded and trailing slashes ignored', () => {
  const m = matchRoute('/join/abc%2Ddef/');
  assert.equal(m.route.name, 'join');
  assert.deepEqual(m.params, { token: 'abc-def' });
  assert.equal(matchRoute('/admin/people').params.section, 'people');
});

test('unknown paths and malformed params do not match', () => {
  assert.equal(matchRoute('/nope'), null);
  assert.equal(matchRoute('/join'), null);
  assert.equal(matchRoute('/join/%E0%A4%A'), null);
  assert.equal(matchRoute('/mine/extra'), null);
});

test('normalizePath', () => {
  assert.equal(normalizePath(''), '/');
  assert.equal(normalizePath('//mine//'), '/mine');
});

test('isAppLink keeps media, the API and the frame out of the router', () => {
  const o = 'https://gma.4mn.org';
  assert.equal(isAppLink(new URL('/mine', o), o), true);
  assert.equal(isAppLink(new URL('/media/01H/large', o), o), false);
  assert.equal(isAppLink(new URL('/api/me', o), o), false);
  assert.equal(isAppLink(new URL('/grandma/', o), o), false);
  assert.equal(isAppLink(new URL('/mine', 'https://example.com'), o), false);
});

test('safeNext: after signing in, only a path on this site; anything else goes home', () => {
  const origin = 'https://gma.4mn.org';
  assert.equal(safeNext('/mine', origin), '/mine');
  assert.equal(safeNext('/admin/people?x=1#top', origin), '/admin/people?x=1#top');
  assert.equal(safeNext(`${origin}/you`, origin), '/you');
  for (const bad of ['/x/..//evil.example', '/%2e%2e//evil.example', '/.//evil.example', '/x/../\\evil.example', '//evil.example', '/\\evil.example', '/\\/evil.example', '\\\\evil.example', 'https://evil.example/mine',
    'javascript:alert(1)', 'http://gma.4mn.org/mine', '', null, undefined]) {
    assert.equal(safeNext(bad, origin), '/', String(bad));
  }
});

test('the sign-in screen checks ?next= with safeNext against its own origin', async () => {
  const { readFileSync } = await import('node:fs');
  const source = readFileSync(new URL('../app/screens/auth.js', import.meta.url), 'utf8');
  assert.match(source, /safeNext\(ctx\.url\.searchParams\.get\('next'\), location\.origin\)/);
  assert.doesNotMatch(source, /function safeNext/, 'one check, the one in router.js');
});

test('the join and confirm pages never ask who is signed in (no 401 on a public page)', async () => {
  const { needsSession } = await import('../app/router.js');
  assert.equal(needsSession('/join/abc123'), false);
  assert.equal(needsSession('/confirm'), false);
  for (const p of ['/', '/mine', '/from-grandma', '/you', '/admin', '/signin', '/upload']) assert.equal(needsSession(p), true, p);
});
