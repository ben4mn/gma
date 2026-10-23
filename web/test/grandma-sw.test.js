// The frame's service worker, loaded in Node with a stand-in `self`, `caches`
// and `fetch`: how it answers page loads, above all the pairing link
// /grandma?device=… that the kiosk opens at boot.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

const ORIGIN = 'https://gma.4mn.org';
const listeners = {};
const stores = new Map();
let network = async () => { throw new TypeError('Failed to fetch'); };

const keyOf = (req) => (typeof req === 'string' ? req : req.url);
function store(name) {
  if (!stores.has(name)) stores.set(name, new Map());
  const map = stores.get(name);
  return {
    match: async (req) => map.get(keyOf(req))?.clone(),
    put: async (req, res) => { map.set(keyOf(req), res); },
    add: async () => {},
    delete: async (req) => map.delete(keyOf(req)),
    keys: async () => [...map.keys()],
  };
}

globalThis.self = {
  location: new URL(`${ORIGIN}/grandma/sw.js`),
  addEventListener: (type, fn) => { listeners[type] = fn; },
  skipWaiting: async () => {},
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
