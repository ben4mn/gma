// The frame's service worker (scope /grandma/, registered as a module).
// - The shell is precached and served network-first, so a new version shows up
//   at the next load and the frame still boots with no internet.
// - /api/frame/state is network-first; the last good copy answers when the
//   server can't, marked X-Gma-Cached: 1 so the page shows the offline line.
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
  if (request.mode === 'navigate' || SHELL.includes(url.href) || url.pathname.startsWith('/assets/')) {
    return event.respondWith(shell(request));
  }
  // everything else (SSE, other API calls) goes straight to the network
});

// ---------- the shell ----------

function withTimeout(promise, ms) {
  return Promise.race([promise, new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), ms))]);
}

async function shell(request) {
  const cache = await caches.open(SHELL_CACHE);
  try {
    const res = await withTimeout(fetch(request), NETWORK_TIMEOUT_MS);
    if (res.ok && res.type === 'basic') cache.put(request.mode === 'navigate' ? here('./') : request, res.clone());
    return res;
  } catch {
    const cached = await cache.match(request.mode === 'navigate' ? here('./') : request, { ignoreSearch: request.mode === 'navigate' });
    return cached ?? new Response('', { status: 504 });
  }
}

// ---------- the frame's state ----------

async function frameState(request) {
  const cache = await caches.open(STATE_CACHE);
  try {
    const res = await withTimeout(fetch(request), NETWORK_TIMEOUT_MS * 2);
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
