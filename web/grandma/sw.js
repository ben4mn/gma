// The frame's service worker (scope /grandma, registered as a module; the
// server sends Service-Worker-Allowed: /grandma with this script).
// - The scope covers the pairing link /grandma?device=… that the kiosk opens at
//   every boot. Online it goes to the server (which sets the cookie and sends
//   the frame on to /grandma/); with no internet, or the server down, it is sent
//   straight to the saved frame, so a power cut never leaves a blank screen.
// - The shell is precached and served network-first, so a new version shows up
//   at the next load and the frame still boots with no internet.
// - /api/frame/state is network-first; the last good copy answers when the
//   server can't (no network, or a 5xx from the tunnel), marked X-Gma-Cached: 1
//   so the page shows the offline line.
// - display/poster renditions: cache-first, the ~300 most recently shown kept.
// - videos: saved whole in the background after the first play (≤ 500 MB in
//   all) and then answered from the cache, Range requests included.
import { VERSION } from './version.js';
import { mediaKind, planEvictions, rangeResponse, LIMITS } from './lib/media-cache.js';

const SHELL_CACHE = `gma-frame-shell-${VERSION}`;
const STATE_CACHE = 'gma-frame-state';
const MEDIA_CACHE = 'gma-frame-media';
const NETWORK_TIMEOUT_MS = 4000;
const here = (path) => new URL(path, self.location).href;
const FRAME_PAGE = here('./'); // /grandma/
const PAIRING_PATH = new URL(FRAME_PAGE).pathname.replace(/\/$/, ''); // /grandma
const INDEX_KEY = here('./__media-index.json');
const STATE_KEY = new URL('/api/frame/state', self.location).href;

const SHELL = [
  './', './grandma.css', './grandma.js', './version.js',
  './lib/api.js', './lib/cards.js', './lib/dom.js', './lib/idle.js', './lib/layout.js', './lib/live.js',
  './lib/media-cache.js', './lib/outbox.js', './lib/outbox-core.js', './lib/recorder.js', './lib/time.js',
  './screens/home.js', './screens/item.js', './screens/night.js', './screens/voice.js',
  '../assets/fonts/fraunces-latin.woff2', '../assets/fonts/atkinson-next-latin.woff2',
  '../assets/emoji/emoji_u2764.svg', '../assets/emoji/emoji_u1f602.svg',
  '../assets/emoji/emoji_u1f62e.svg', '../assets/emoji/emoji_u1f64f.svg',
].map(here);

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(SHELL_CACHE);
    // one missing file must not stop the rest from being saved
    await Promise.allSettled(SHELL.map((url) => cache.add(new Request(url, { cache: 'reload' }))));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    for (const name of await caches.keys()) {
      if (name.startsWith('gma-frame-shell-') && name !== SHELL_CACHE) await caches.delete(name);
    }
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  if (url.pathname === '/api/frame/state') return event.respondWith(frameState(request));
  const kind = mediaKind(url.pathname);
  if (kind === 'image') return event.respondWith(cachedImage(request));
  if (kind === 'video') return event.respondWith(cachedVideo(event, request));
  if (request.mode === 'navigate') return event.respondWith(page(request, url));
  if (SHELL.includes(url.href) || url.pathname.startsWith('/assets/')) return event.respondWith(shell(request));
  // everything else (SSE, other API calls) goes straight to the network
});

// ---------- the shell ----------

function withTimeout(promise, ms) {
  let timer;
  const timeout = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('timeout')), ms); });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

async function shell(request) {
  const cache = await caches.open(SHELL_CACHE);
  try {
    const res = await withTimeout(fetch(request), NETWORK_TIMEOUT_MS);
    if (res.ok && res.type === 'basic') cache.put(request, res.clone());
    return res;
  } catch {
    return (await cache.match(request)) ?? new Response('', { status: 504 });
  }
}

/**
 * A page load: /grandma/ (the frame) or /grandma?device=… (the pairing link).
 * Network first; when the network fails or the server behind the tunnel is down
 * (a 5xx), the saved frame. The pairing link is answered with a redirect to it:
 * the frame's relative links only resolve from /grandma/, and the token stays
 * out of the address bar, as the server does it.
 */
async function page(request, url) {
  const cache = await caches.open(SHELL_CACHE);
  const pairing = url.pathname === PAIRING_PATH;
  try {
    const res = await withTimeout(fetch(request), NETWORK_TIMEOUT_MS);
    if (res.status >= 500) throw new Error(`HTTP ${res.status}`);
    // only the frame itself is saved (never a redirect, a "not set up" page or a sign-in)
    if (!pairing && res.status === 200 && res.type === 'basic' && !res.redirected) cache.put(FRAME_PAGE, res.clone());
    return res;
  } catch {
    const saved = await cache.match(FRAME_PAGE);
    if (saved) return pairing ? Response.redirect(FRAME_PAGE, 302) : saved;
    return offlinePage();
  }
}

/** Only before the frame was ever saved: a calm line that tries again by itself. */
function offlinePage() {
  return new Response(
    '<!doctype html><html lang="en"><meta charset="utf-8"><meta http-equiv="refresh" content="30">'
    + '<title>Grandma’s photos</title><p>No internet right now. The photos will be back soon.</p></html>',
    { status: 503, headers: { 'Content-Type': 'text/html; charset=utf-8' } },
  );
}

// ---------- the frame's state ----------

async function frameState(request) {
  const cache = await caches.open(STATE_CACHE);
  try {
    const res = await withTimeout(fetch(request), NETWORK_TIMEOUT_MS * 2);
    if (res.status >= 500) throw new Error(`HTTP ${res.status}`); // the tunnel answers, the server doesn't
    if (res.ok) await cache.put(STATE_KEY, res.clone());
    return res;
  } catch {
    const cached = await cache.match(STATE_KEY);
    if (!cached) {
      return new Response(JSON.stringify({ error: { code: 'offline', message: 'No internet right now.' } }), {
        status: 503, headers: { 'Content-Type': 'application/json' },
      });
    }
    const headers = new Headers(cached.headers);
    headers.set('X-Gma-Cached', '1');
    return new Response(await cached.blob(), { status: 200, headers });
  }
}

// ---------- the media index (LRU bookkeeping), one writer at a time ----------

let index = null;
let indexQueue = Promise.resolve();

function updateIndex(fn) {
  indexQueue = indexQueue.then(async () => {
    const cache = await caches.open(MEDIA_CACHE);
    if (!index) index = (await (await cache.match(INDEX_KEY))?.json().catch(() => null)) ?? [];
    const evict = fn(index) ?? [];
    for (const url of evict) await cache.delete(url);
    if (evict.length) index = index.filter((e) => !evict.includes(e.url));
    await cache.put(INDEX_KEY, new Response(JSON.stringify(index), { headers: { 'Content-Type': 'application/json' } }));
  }).catch(() => {});
  return indexQueue;
}

function touch(url, kind, bytes) {
  return updateIndex((list) => {
    const found = list.find((e) => e.url === url);
    if (found) found.used_at = Date.now();
    else list.push({ url, kind, bytes, used_at: Date.now() });
    return found ? [] : planEvictions(list, LIMITS);
  });
}

// ---------- photos ----------

async function cachedImage(request) {
  const cache = await caches.open(MEDIA_CACHE);
  const key = request.url;
  const hit = await cache.match(key);
  if (hit) {
    touch(key, 'image', 0);
    return hit;
  }
  const res = await fetch(request);
  if (res.status === 200) {
    await cache.put(key, res.clone());
    touch(key, 'image', Number(res.headers.get('Content-Length')) || 0);
  }
  return res;
}

// ---------- videos ----------

const downloading = new Set();

async function cachedVideo(event, request) {
  const cache = await caches.open(MEDIA_CACHE);
  const key = request.url;
  const hit = await cache.match(key);
  if (hit) {
    touch(key, 'video', 0);
    const range = request.headers.get('Range');
    return range ? rangeResponse(hit, range) : hit;
  }
  // play from the network now; save the whole file quietly for next time
  if (!downloading.has(key)) {
    downloading.add(key);
    event.waitUntil(saveVideo(cache, key).finally(() => downloading.delete(key)));
  }
  return fetch(request);
}

async function saveVideo(cache, key) {
  try {
    const res = await fetch(key, { credentials: 'same-origin' });
    if (res.status !== 200) return;
    const bytes = Number(res.headers.get('Content-Length')) || 0;
    if (bytes > LIMITS.maxVideoBytes) return;
    await cache.put(key, res);
    await touch(key, 'video', bytes);
  } catch { /* offline or interrupted: it will be tried at the next play */ }
}
