import { test } from 'node:test';
import assert from 'node:assert/strict';
import { matchRoute, normalizePath, isAppLink } from '../app/router.js';

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
