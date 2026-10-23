// The public landing page: GET / for a signed-out visitor is web/landing.html
// (a short explanation of the frame, for anyone who has the link), a signed-in
// family member still gets the shell, and Grandma's frame goes to /grandma/.
// The page is static and strict-CSP clean: no inline style or script, nothing
// from another origin, every picture self-hosted, small and described.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { loginAs, loginAsDevice, makeDevice, makeTestApp, makeUser } from './helpers/index.js';

const WEB = fileURLToPath(new URL('../../web/', import.meta.url));
const LANDING = path.join(WEB, 'landing.html');
const REVALIDATE_HTML = 'no-cache, no-transform';
const MAX_IMAGE_BYTES = 200 * 1024;

const landingHtml = () => fs.readFileSync(LANDING, 'utf8');

// Every same-site URL the page asks for: stylesheets, icons, images (src and srcset).
function referencedUrls(html) {
  const urls = new Set();
  for (const m of html.matchAll(/\s(?:href|src)="([^"]+)"/g)) urls.add(m[1]);
  for (const m of html.matchAll(/\ssrcset="([^"]+)"/g)) {
    for (const part of m[1].split(',')) urls.add(part.trim().split(/\s+/)[0]);
  }
  return [...urls];
}

describe('landing page: routing', () => {
  let t;
  let member;
  let admin;
  let device;
  before(async () => {
    t = await makeTestApp(); // the real web/ folder
    member = loginAs(t.app, t.db, makeUser(t.db));
    admin = loginAs(t.app, t.db, makeUser(t.db, { role: 'admin' }));
    device = loginAsDevice(t.app, t.db, makeDevice(t.db));
  });
  after(async () => {
    await t.cleanup();
  });
  const get = (url, cookie, method = 'GET') => t.app.inject({ method, url, headers: cookie ? { cookie } : {} });

  test('signed out, / is the landing page: 200, revalidated, never indexed', async () => {
    const res = await get('/');
    assert.equal(res.statusCode, 200);
    assert.match(res.headers['content-type'], /^text\/html/);
    assert.equal(res.headers['cache-control'], REVALIDATE_HTML);
    assert.equal(res.headers['x-robots-tag'], 'noindex, nofollow');
    assert.match(res.headers['content-security-policy'], /default-src 'self'/);
    assert.equal(res.headers['set-cookie'], undefined, 'a visitor gets no cookie');
    assert.equal(res.body, landingHtml());
    assert.match(res.body, /<meta name="robots" content="noindex, nofollow">/);
  });

  test('HEAD / and a query string get the landing page too', async () => {
    assert.equal((await get('/', null, 'HEAD')).statusCode, 200);
    const res = await get('/?ref=email');
    assert.equal(res.statusCode, 200);
    assert.equal(res.body, landingHtml());
  });

  test('signed in, / is still the family shell (members and admins)', async () => {
    const shell = fs.readFileSync(path.join(WEB, 'index.html'), 'utf8');
    for (const cookie of [member, admin]) {
      const res = await get('/', cookie);
      assert.equal(res.statusCode, 200);
      assert.equal(res.body, shell);
      assert.equal(res.headers['cache-control'], REVALIDATE_HTML);
    }
  });

  test("Grandma's frame opening / goes to its own page", async () => {
    const res = await get('/', device);
    assert.equal(res.statusCode, 302);
    assert.equal(res.headers.location, '/grandma/');
  });

  test('a revoked frame or an unknown cookie is a visitor', async () => {
    const revoked = makeDevice(t.db);
    const cookie = loginAsDevice(t.app, t.db, revoked);
    t.db.prepare('UPDATE devices SET revoked_at = ? WHERE id = ?').run(Date.now(), revoked.id);
    for (const c of [cookie, 'gma_session=not-a-real-token']) {
      const res = await get('/', c);
      assert.equal(res.statusCode, 200);
      assert.equal(res.body, landingHtml());
    }
  });

  test('every other private page still goes to /signin?next=', async () => {
    for (const url of ['/from-grandma', '/mine', '/upload', '/you', '/admin', '/grandma/']) {
      const res = await get(url);
      assert.equal(res.statusCode, 302, url);
      assert.equal(res.headers.location, `/signin?next=${encodeURIComponent(url)}`, url);
    }
    const signin = await get('/signin');
    assert.equal(signin.statusCode, 200);
    assert.notEqual(signin.body, landingHtml(), '/signin is the shell, not the landing page');
  });

  test('only the shell is marked as the shell, so the family worker never keeps the landing page for offline launches', async () => {
    for (const [url, cookie] of [['/'], ['/landing.html'], ['/?ref=email']]) {
      const res = await get(url, cookie);
      assert.equal(res.statusCode, 200, url);
      assert.equal(res.headers['x-gma-page'], undefined, url);
    }
    for (const [url, cookie] of [['/', member], ['/', admin], ['/signin'], ['/confirm'], ['/join/abc'], ['/mine', member], ['/admin', admin]]) {
      const res = await get(url, cookie);
      assert.equal(res.statusCode, 200, url);
      assert.equal(res.headers['x-gma-page'], 'shell', url);
    }
  });

  test("the landing page's stylesheet and pictures are served, with the usual caching", async () => {
    const css = await get('/landing.css');
    assert.equal(css.statusCode, 200);
    assert.match(css.headers['content-type'], /^text\/css/);
    assert.equal(css.headers['cache-control'], 'no-cache');
    const images = referencedUrls(landingHtml()).filter((u) => u.startsWith('/assets/landing/'));
    assert.ok(images.length >= 2, 'the frame and the phone screenshots');
    for (const url of images) {
      const res = await get(url);
      assert.equal(res.statusCode, 200, url);
      assert.match(res.headers['content-type'], /^image\/webp/, url);
      assert.equal(res.headers['cache-control'], 'public, max-age=31536000, immutable', url);
    }
  });
});

describe('landing page: the file itself', () => {
  const html = landingHtml();

  test('a complete page: language, viewport, title, description, the shared look', () => {
    assert.match(html, /^<!doctype html>/i);
    assert.match(html, /<html lang="en">/);
    assert.match(html, /<meta name="viewport" content="width=device-width, initial-scale=1[^"]*">/);
    assert.match(html, /<title>[^<]+<\/title>/);
    assert.match(html, /<meta name="description" content="[^"]+">/);
    assert.match(html, /<link rel="stylesheet" href="\/shared\/tokens\.css">/);
    assert.match(html, /<link rel="stylesheet" href="\/landing\.css">/);
  });

  test('strict CSP clean: no inline style, no script, no inline handlers', () => {
    assert.doesNotMatch(html, /<style/i);
    assert.doesNotMatch(html, /\sstyle="/i);
    assert.doesNotMatch(html, /<script/i);
    assert.doesNotMatch(html, /\son[a-z]+="/i);
    assert.doesNotMatch(html, /javascript:/i);
  });

  test('nothing comes from another origin', () => {
    for (const url of referencedUrls(html)) {
      if (url.startsWith('#')) continue; // the skip link
      assert.ok(url.startsWith('/') && !url.startsWith('//'), `${url} must be a same-site path`);
    }
    assert.doesNotMatch(html, /\b(?:src|href|srcset)="(?:https?:)?\/\//i);
    const css = fs.readFileSync(path.join(WEB, 'landing.css'), 'utf8');
    assert.doesNotMatch(css, /@import/i);
    assert.doesNotMatch(css, /url\(\s*["']?(?:https?:)?\/\//i);
  });

  test('every file it asks for exists in web/', () => {
    for (const url of referencedUrls(html)) {
      if (url === '/signin' || url.startsWith('#')) continue;
      assert.ok(fs.existsSync(path.join(WEB, url)), `${url} is missing`);
    }
  });

  test('the way in: Sign in goes to /signin, and invitees are told to use their link', () => {
    assert.match(html, /<a [^>]*href="\/signin"[^>]*>\s*Sign in\s*<\/a>/);
    assert.match(html, /Got an invite\? Open the link in your email\./);
    assert.match(html, /Invite only\. Ask the person who runs your family’s frame for an invite\./);
  });

  test('every picture is described, sized and small', () => {
    const imgs = [...html.matchAll(/<img\b[^>]*>/g)].map((m) => m[0]);
    assert.ok(imgs.length >= 2);
    for (const img of imgs) {
      assert.match(img, /\salt="[^"]{12,}"/, `${img} needs real alt text`);
      assert.match(img, /\swidth="\d+"/, img);
      assert.match(img, /\sheight="\d+"/, img);
      assert.match(img, /\sloading="(lazy|eager)"/, img);
    }
    const files = fs.readdirSync(path.join(WEB, 'assets', 'landing')).filter((f) => f.endsWith('.webp'));
    assert.ok(files.length >= 2);
    for (const f of files) {
      const size = fs.statSync(path.join(WEB, 'assets', 'landing', f)).size;
      assert.ok(size <= MAX_IMAGE_BYTES, `${f} is ${size} bytes (≤ ${MAX_IMAGE_BYTES})`);
    }
  });

  test('generic: no family names, sentence case, and the principles in plain words', () => {
    for (const name of ['Sarah', 'Mike', 'Lily', 'Rosie', 'Carol', 'Ben ', 'Lee']) {
      assert.doesNotMatch(html, new RegExp(`\\b${name}`), `no names on the page (${name})`);
    }
    for (const phrase of [/nothing to manage/i, /one tap/i, /nothing plays by itself/i, /power cut/i, /private/i, /no ads/i]) {
      assert.match(html, phrase);
    }
  });
});
