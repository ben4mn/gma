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

const SHELL_PREFIX = 'gma-frame-shell-';
const SHELL_CACHE = `${SHELL_PREFIX}${VERSION}`;
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
  './lib/api.js', './lib/cards.js', './lib/clock.js', './lib/dom.js', './lib/idle.js', './lib/layout.js', './lib/live.js',
  './lib/media-cache.js', './lib/outbox.js', './lib/outbox-core.js', './lib/recorder.js', './lib/time.js',
  './screens/home.js', './screens/item.js', './screens/night.js', './screens/voice.js',
  '../assets/fonts/fraunces-latin.woff2', '../assets/fonts/atkinson-next-latin.woff2',
  '../assets/emoji/emoji_u2764.svg', '../assets/emoji/emoji_u1f602.svg',
  '../assets/emoji/emoji_u1f62e.svg', '../assets/emoji/emoji_u1f64f.svg',
].map(here);

// An update is all or nothing. Every shell file is fetched and read whole before
// any of it is written, so a Wi-Fi blip mid-update never leaves a half-filled
// cache: the install fails, the old worker keeps serving its complete shell, and
// the browser tries again at the next update check (the frame asks every hour).
self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    await precacheShell();
    await self.skipWaiting();
  })());
});

async function precacheShell() {
  const files = await Promise.all(SHELL.map(async (url) => {
    const res = await fetch(new Request(url, { cache: 'reload', credentials: 'same-origin' }));
    // a redirect here is a sign-in page or similar, never the file we asked for
    if (!res.ok || res.redirected) throw new Error(`Could not save ${url} (HTTP ${res.status})`);
    const body = await res.arrayBuffer(); // the whole file is here before anything is written
    return [url, new Response(body, { status: res.status, statusText: res.statusText, headers: res.headers })];
  }));
  const cache = await caches.open(SHELL_CACHE);
  await Promise.all(files.map(([url, res]) => cache.put(url, res)));
}

/** True when `name` holds every shell file. */
async function shellComplete(name) {
  const cache = await caches.open(name);
  const found = await Promise.all(SHELL.map((url) => cache.match(url)));
  return found.every(Boolean);
}

// The old shell is deleted only once the new one is known to be complete.
self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    if (await shellComplete(SHELL_CACHE)) {
      for (const name of await caches.keys()) {
        if (name.startsWith(SHELL_PREFIX) && name !== SHELL_CACHE) await caches.delete(name);
      }
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
    return (await cache.match(request)) ?? (await savedShell(request)) ?? new Response('', { status: 504 });
  }
}

/** A shell file from any saved version: better an older file than a blank frame. */
async function savedShell(request) {
  const names = (await caches.keys()).filter((n) => n.startsWith(SHELL_PREFIX) && n !== SHELL_CACHE);
  for (const name of names.reverse()) {
    const hit = await (await caches.open(name)).match(request);
    if (hit) return hit;
  }
  return undefined;
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
    const saved = (await cache.match(FRAME_PAGE)) ?? (await savedShell(FRAME_PAGE));
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
// The index lives in memory; a cache hit only moves a timestamp there. It is
// written to the cache (the Pi's SD card) a couple of seconds after a burst of
// use settles, so one write holds the whole burst: for timestamps alone at most
// every INDEX_SAVE_MS, when files joined or left every time, and when the page
// goes away. Nothing is lost for good if the worker stops first: when the index
// is loaded it is checked against what is really cached, so a file it never
// heard of is adopted (dated by its server response) and an entry whose file is
// gone is dropped.

const INDEX_SAVE_MS = 10 * 60_000;
const INDEX_SETTLE_MS = 2000;
let index = null;
let indexDirty = false;
let indexSavedAt = 0; // kept in the saved index, so the pace holds across worker restarts
let indexTimer = null;
let indexQueue = Promise.resolve();

async function loadIndex(cache) {
  if (index) return index;
  const saved = await (await cache.match(INDEX_KEY))?.json().catch(() => null);
  const entries = Array.isArray(saved) ? saved : Array.isArray(saved?.entries) ? saved.entries : [];
  indexSavedAt = Number(saved?.saved_at) || 0;
  const keys = new Set((await cache.keys()).map((k) => (typeof k === 'string' ? k : k.url)).filter((u) => u !== INDEX_KEY));
  const list = entries.filter((e) => e && keys.has(e.url));
  const known = new Set(list.map((e) => e.url));
  for (const url of keys) {
    const kind = mediaKind(new URL(url).pathname);
    if (!kind || known.has(url)) continue;
    const headers = (await cache.match(url))?.headers;
    list.push({
      url, kind,
      bytes: Number(headers?.get('Content-Length')) || 0,
      used_at: Date.parse(headers?.get('Date') ?? '') || 0,
    });
  }
  index = list;
  indexDirty = list.length !== entries.length;
  return index;
}

async function saveIndex() {
  if (!index || !indexDirty) return;
  const cache = await caches.open(MEDIA_CACHE);
  indexSavedAt = Date.now();
  indexDirty = false;
  await cache.put(INDEX_KEY, new Response(JSON.stringify({ saved_at: indexSavedAt, entries: index }), {
    headers: { 'Content-Type': 'application/json' },
  }));
}

/** Save once use has settled: a change of files always, timestamps only if the last save was a while ago. */
function saveIndexLater(filesChanged) {
  if (!filesChanged && Date.now() - indexSavedAt < INDEX_SAVE_MS) return;
  clearTimeout(indexTimer);
  indexTimer = setTimeout(() => { indexTimer = null; flushIndex(); }, INDEX_SETTLE_MS);
  indexTimer.unref?.();
}

/** fn(list) changes the index in memory; it returns {joined, evict: [urls]}. */
function updateIndex(fn) {
  indexQueue = indexQueue.then(async () => {
    const cache = await caches.open(MEDIA_CACHE);
    await loadIndex(cache);
    const { joined = false, evict = [] } = fn(index) ?? {};
    for (const url of evict) await cache.delete(url);
    if (evict.length) index = index.filter((e) => !evict.includes(e.url));
    indexDirty = true;
    saveIndexLater(joined || evict.length > 0);
  }).catch(() => {});
  return indexQueue;
}

/** Write what is unsaved now (the page asks when it goes away). */
function flushIndex() {
  clearTimeout(indexTimer);
  indexTimer = null;
  indexQueue = indexQueue.then(saveIndex).catch(() => {});
  return indexQueue;
}

function touch(url, kind, bytes) {
  return updateIndex((list) => {
    const found = list.find((e) => e.url === url);
    if (found) {
      found.used_at = Date.now();
      if (bytes && !found.bytes) found.bytes = bytes;
      return { joined: false };
    }
    list.push({ url, kind, bytes, used_at: Date.now() });
    return { joined: true, evict: planEvictions(list, LIMITS) };
  });
}

self.addEventListener('message', (event) => {
  if (event.data?.type === 'gma-save-index') event.waitUntil?.(flushIndex());
});

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
