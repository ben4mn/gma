// The frame's service worker, loaded in Node with a stand-in `self`, `caches`
// and `fetch`: how it answers page loads, above all the pairing link
// /grandma?device=… that the kiosk opens at boot.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

const ORIGIN = 'https://gma.4mn.org';
const listeners = {};
const stores = new Map();
const puts = []; // every cache.put, as [cache name, key]
let skipped = 0;
let network = async () => { throw new TypeError('Failed to fetch'); };

const keyOf = (req) => (typeof req === 'string' ? req : req.url);
function store(name) {
  if (!stores.has(name)) stores.set(name, new Map());
  const map = stores.get(name);
  return {
    match: async (req) => map.get(keyOf(req))?.clone(),
    put: async (req, res) => { puts.push([name, keyOf(req)]); map.set(keyOf(req), res); },
    add: async () => {},
    delete: async (req) => map.delete(keyOf(req)),
    keys: async () => [...map.keys()],
  };
}

globalThis.self = {
  location: new URL(`${ORIGIN}/grandma/sw.js`),
  addEventListener: (type, fn) => { listeners[type] = fn; },
  skipWaiting: async () => { skipped += 1; },
  clients: { claim: async () => {} },
};
globalThis.caches = { open: async (name) => store(name), keys: async () => [...stores.keys()], delete: async (n) => stores.delete(n) };
globalThis.fetch = (...args) => network(...args);

const { VERSION } = await import('../grandma/version.js');
await import('../grandma/sw.js');
const SHELL_CACHE = `gma-frame-shell-${VERSION}`;
const FRAME_PAGE = `${ORIGIN}/grandma/`;

function load(path, { mode = 'navigate' } = {}) {
  let answer = null;
  listeners.fetch({
    request: { method: 'GET', url: `${ORIGIN}${path}`, mode, headers: new Headers() },
    respondWith: (p) => { answer = p; },
    waitUntil: () => {},
  });
  return answer;
}

// fetch() answers a same-origin request with a 'basic' response; new Response() is 'default'.
const as = (res, type) => Object.defineProperty(res, 'type', { value: type });
const html = (body, init = {}) => as(new Response(body, { status: 200, headers: { 'Content-Type': 'text/html' }, ...init }), 'basic');
// What fetch() gives a worker for a page that redirects (navigations use redirect: 'manual').
const opaqueRedirect = () => as(new Response(null, { status: 200 }), 'opaqueredirect');

beforeEach(() => {
  stores.clear();
  puts.length = 0;
  skipped = 0;
  network = async () => { throw new TypeError('Failed to fetch'); };
});

test('online, the pairing link goes to the server, and nothing about it is saved', async () => {
  const fromServer = opaqueRedirect();
  network = async () => fromServer;
  const res = await load('/grandma?device=tok_123');
  assert.equal(res, fromServer);
  assert.equal(await (await caches.open(SHELL_CACHE)).match(FRAME_PAGE), undefined);
});

test('offline, the pairing link opens the saved frame at /grandma/', async () => {
  await (await caches.open(SHELL_CACHE)).put(FRAME_PAGE, html('<p>frame</p>'));
  const res = await load('/grandma?device=tok_123');
  assert.equal(res.status, 302);
  assert.equal(res.headers.get('Location'), FRAME_PAGE);
});

test('the server down behind the tunnel (a 5xx) counts as offline', async () => {
  await (await caches.open(SHELL_CACHE)).put(FRAME_PAGE, html('<p>frame</p>'));
  network = async () => new Response('Bad gateway', { status: 502 });
  assert.equal((await load('/grandma?device=tok_123')).headers.get('Location'), FRAME_PAGE);
  const page = await load('/grandma/');
  assert.equal(page.status, 200);
  assert.equal(await page.text(), '<p>frame</p>');
});

test('the frame page is saved when it loads, and answers from the cache offline', async () => {
  network = async () => html('<p>new frame</p>');
  const online = await load('/grandma/');
  assert.equal(await online.text(), '<p>new frame</p>');
  const saved = await (await caches.open(SHELL_CACHE)).match(FRAME_PAGE);
  assert.equal(await saved.text(), '<p>new frame</p>');

  network = async () => { throw new TypeError('Failed to fetch'); };
  const offline = await load('/grandma/?fixture=0');
  assert.equal(await offline.text(), '<p>new frame</p>');
});

test('a "not set up" answer to the pairing link is shown but never saved as the frame', async () => {
  network = async () => html('<h1>This frame isn’t set up yet.</h1>', { status: 403 });
  const res = await load('/grandma?device=revoked');
  assert.equal(res.status, 403);
  assert.equal(await (await caches.open(SHELL_CACHE)).match(FRAME_PAGE), undefined);
});

test('offline before the frame was ever saved: a calm page that tries again', async () => {
  const res = await load('/grandma?device=tok_123');
  assert.equal(res.status, 503);
  const body = await res.text();
  assert.match(body, /No internet right now/);
  assert.match(body, /http-equiv="refresh"/);
});

test('the frame state falls back to the last good copy on a 5xx', async () => {
  network = async () => new Response('{"slideshow":[1]}', { status: 200, headers: { 'Content-Type': 'application/json' } });
  assert.equal((await load('/api/frame/state', { mode: 'cors' })).status, 200);
  network = async () => new Response('', { status: 530 });
  const res = await load('/api/frame/state', { mode: 'cors' });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('X-Gma-Cached'), '1');
  assert.deepEqual(await res.json(), { slideshow: [1] });
});

// ---------- updates: all or nothing (OPS-5) ----------

const SHELL_FILES = ['grandma/', 'grandma/grandma.js', 'grandma/lib/time.js', 'assets/fonts/fraunces-latin.woff2'];
const OLD_SHELL = 'gma-frame-shell-frame-old';

function install() {
  let done = null;
  listeners.install({ waitUntil: (p) => { done = p; } });
  return done;
}
function activate() {
  let done = null;
  listeners.activate({ waitUntil: (p) => { done = p; } });
  return done;
}
async function savedOld() {
  const old = await caches.open(OLD_SHELL);
  for (const f of SHELL_FILES) await old.put(`${ORIGIN}/${f}`, new Response(`old ${f}`));
}

test('an update that loses one file to a Wi-Fi blip fails whole, and the old shell stays', async () => {
  await savedOld();
  network = async (req) => {
    if (keyOf(req).endsWith('/lib/time.js')) throw new TypeError('Failed to fetch');
    return new Response('new');
  };
  await assert.rejects(install());
  assert.equal(skipped, 0, 'the new worker must not take over');
  assert.equal((await (await caches.open(SHELL_CACHE)).keys()).length, 0, 'nothing half-saved');
  assert.equal(await (await (await caches.open(OLD_SHELL)).match(`${ORIGIN}/grandma/grandma.js`)).text(), 'old grandma/grandma.js');
});

test('a sign-in redirect is never saved as a shell file', async () => {
  network = async (req) => Object.defineProperty(new Response('<h1>Sign in</h1>'), 'redirected', { value: keyOf(req).endsWith('/grandma.js') });
  await assert.rejects(install());
  assert.equal(skipped, 0);
});

test('a complete update saves every file, then retires the old shell', async () => {
  await savedOld();
  network = async (req) => new Response(`new ${keyOf(req)}`);
  await install();
  assert.equal(skipped, 1);
  const cache = await caches.open(SHELL_CACHE);
  for (const f of SHELL_FILES) assert.ok(await cache.match(`${ORIGIN}/${f}`), f);
  await activate();
  assert.equal(stores.has(OLD_SHELL), false);
});

test('activate keeps the old shell when the new one is missing a file', async () => {
  await savedOld();
  await (await caches.open(SHELL_CACHE)).put(FRAME_PAGE, html('<p>frame</p>'));
  await activate();
  assert.equal(stores.has(OLD_SHELL), true);
});

test('offline, a file missing from the new shell comes from an older one, never a 504', async () => {
  await savedOld();
  const res = await load('/grandma/grandma.js', { mode: 'no-cors' });
  assert.equal(res.status, 200);
  assert.equal(await res.text(), 'old grandma/grandma.js');
});

// ---------- the media index: few writes to the SD card (OPS-7) ----------

const MEDIA = 'gma-frame-media';
const INDEX = `${ORIGIN}/grandma/__media-index.json`;
const photoUrl = (i) => `${ORIGIN}/media/p${i}/display`;
const indexWrites = () => puts.filter(([name, key]) => name === MEDIA && key === INDEX).length;

test('300 slideshow hits rewrite the index once, not 300 times; a file it missed is adopted', { timeout: 15_000 }, async () => {
  const media = await caches.open(MEDIA);
  for (let i = 0; i < 300; i += 1) await media.put(photoUrl(i), new Response('jpeg', { headers: { Date: 'Wed, 21 Oct 2026 10:00:00 GMT' } }));
  // an index from before: it lists p0..p298 and a photo that is gone; p299 was never recorded
  const entries = [...Array(299).keys()].map((i) => ({ url: photoUrl(i), kind: 'image', bytes: 0, used_at: 1 }));
  entries.push({ url: `${ORIGIN}/media/gone/display`, kind: 'image', bytes: 0, used_at: 1 });
  await media.put(INDEX, new Response(JSON.stringify(entries)));
  puts.length = 0;

  const hits = async () => {
    for (let i = 0; i < 300; i += 1) {
      const res = await load(`/media/p${i}/display`, { mode: 'no-cors' });
      assert.equal(res.status, 200);
    }
  };
  await hits();
  assert.equal(indexWrites(), 0, 'a hit only moves a timestamp in memory');
  await new Promise((r) => setTimeout(r, 2300)); // the burst settles
  assert.equal(indexWrites(), 1);
  const saved = await (await media.match(INDEX)).json();
  const urls = saved.entries.map((e) => e.url);
  assert.equal(urls.length, 300);
  assert.ok(urls.includes(photoUrl(299)), 'the missed photo is adopted');
  assert.ok(!urls.some((u) => u.includes('/gone/')), 'the gone photo is dropped');
  assert.ok(saved.entries.every((e) => e.used_at > 1), 'every hit was recorded');

  await hits(); // five minutes later, the next warm-up
  await new Promise((r) => setTimeout(r, 2300));
  assert.equal(indexWrites(), 1, 'timestamps alone wait for the next save window');

  let kept = null;
  listeners.message({ data: { type: 'gma-save-index' }, waitUntil: (p) => { kept = p; } });
  await kept; // the page went away: what is unsaved is written now
  assert.equal(indexWrites(), 2);
});

test('every module the frame imports is in the precached shell, or it cannot start offline', async () => {
  const fs = await import('node:fs/promises');
  const root = new URL('../grandma/', import.meta.url);
  const sw = await fs.readFile(new URL('sw.js', root), 'utf8');
  const shellList = sw.slice(sw.indexOf('const SHELL = ['), sw.indexOf('].map(here)'));
  const seen = new Set();
  const walk = async (url) => {
    if (seen.has(url.href)) return;
    seen.add(url.href);
    const text = await fs.readFile(url, 'utf8');
    for (const [, spec] of text.matchAll(/^(?:import|export)[^'"]*?from\s+'(\.{1,2}\/[^']+)'/gm)) await walk(new URL(spec, url));
  };
  await walk(new URL('grandma.js', root));
  for (const href of seen) {
    const rel = `./${href.slice(root.href.length)}`;
    assert.ok(shellList.includes(`'${rel}'`), `${rel} is imported by the frame but not precached in sw.js SHELL`);
  }
  assert.ok(seen.size > 10);
});
