// The family app's service worker (scope /).
// - The shell (modules, styles, fonts, icons) is precached per VERSION; bump it on every release.
// - Pages are network-first, falling back to the last good copy of the shell.
// - Photo renditions from /media are cache-first, in a capped cache.
// - API GETs are network-first, with the last good answer when offline.
// - Every push shows a notification (iOS revokes push for silent ones).

const VERSION = 'family-2026-10-23-1';
const SHELL_CACHE = `shell-${VERSION}`;
const PAGE_CACHE = 'pages';
const MEDIA_CACHE = 'media-v1';
const API_CACHE = 'api-v1';
const MEDIA_MAX_ENTRIES = 400;
const MEDIA_MAX_BYTES = 200 * 1024 * 1024;
// Every family path serves the same shell; the server lets anyone load it at /signin.
const SHELL_PAGE = '/signin';

const SHELL = [
  '/manifest.webmanifest',
  '/shared/tokens.css',
  '/shared/api.js',
  '/shared/time.js',
  '/shared/sse.js',
  '/shared/icons.js',
  '/shared/dom.js',
  '/shared/names.js',
  '/app/app.css',
  '/app/main.js',
  '/app/router.js',
  '/app/session.js',
  '/app/data.js',
  '/app/invite-copy.js',
  '/app/admin-health.js',
  '/app/grouping.js',
  '/app/platform.js',
  '/app/upload-queue.js',
  '/app/uploader.js',
  '/app/push.js',
  '/app/passkeys.js',
  '/app/components/infinite-list.js',
  '/app/screens/shell.js',
  '/app/screens/feeds.js',
  '/app/screens/grandma-feed.js',
  '/app/screens/viewer.js',
  '/app/screens/upload.js',
  '/app/screens/prompts.js',
  '/app/screens/auth.js',
  '/app/screens/you.js',
  '/app/screens/admin.js',
  '/vendor/tus-js-client/tus.js',
  '/vendor/simplewebauthn-browser/index.js',
  '/assets/fonts/fraunces-latin.woff2',
  '/assets/fonts/fraunces-italic-latin.woff2',
  '/assets/fonts/atkinson-next-latin.woff2',
  '/assets/emoji/emoji_u2764.svg',
  '/assets/emoji/emoji_u1f602.svg',
  '/assets/emoji/emoji_u1f62e.svg',
  '/assets/emoji/emoji_u1f64f.svg',
  '/assets/icons/icon.svg',
  '/assets/icons/icon-192.png',
];

// Image renditions only: video and voice are streamed with Range requests.
const CACHEABLE_MEDIA = /^\/media\/[^/]+\/(thumb|display|large|poster)$/;
const NO_CACHE_API = /^\/api\/(events|auth\/|push\/|uploads|admin\/)/;

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(SHELL_CACHE);
    // One missing file shouldn't stop the whole worker installing.
    await Promise.all([SHELL_PAGE, ...SHELL].map((url) => cache.add(new Request(url, { cache: 'reload' })).catch(() => {})));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keep = new Set([SHELL_CACHE, PAGE_CACHE, MEDIA_CACHE, API_CACHE]);
    for (const key of await caches.keys()) if (!keep.has(key)) await caches.delete(key);
    await self.clients.claim();
  })());
});

async function trimMedia(cache) {
  const keys = await cache.keys();
  let bytes = 0;
  const sizes = await Promise.all(keys.map(async (req) => Number((await cache.match(req))?.headers.get('content-length')) || 150_000));
  for (const s of sizes) bytes += s;
  // Oldest first (insertion order); drop until under both caps.
  for (let i = 0; i < keys.length && (keys.length - i > MEDIA_MAX_ENTRIES || bytes > MEDIA_MAX_BYTES); i += 1) {
    bytes -= sizes[i];
    await cache.delete(keys[i]);
  }
}

async function mediaFirst(request) {
  const cache = await caches.open(MEDIA_CACHE);
  const hit = await cache.match(request);
  if (hit) return hit;
  const res = await fetch(request);
  if (res.status === 200) {
    await cache.put(request, res.clone());
    trimMedia(cache);
  }
  return res;
}

async function networkFirst(request, cacheName) {
  const cache = await caches.open(cacheName);
  try {
    const res = await fetch(request);
    if (res.status === 200) cache.put(request, res.clone());
    return res;
  } catch (err) {
    const hit = await cache.match(request);
    if (hit) return hit;
    throw err;
  }
}

async function page(request) {
  const cache = await caches.open(PAGE_CACHE);
  try {
    const res = await fetch(request);
    // Every family path serves the same shell; keep the newest good copy for offline launches.
    if (res.status === 200 && !res.redirected && (res.headers.get('content-type') || '').includes('text/html')) {
      cache.put('/__shell', res.clone());
    }
    return res;
  } catch {
    return (await cache.match('/__shell')) ?? (await caches.match(SHELL_PAGE, { cacheName: SHELL_CACHE })) ?? new Response(
      '<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Grandma’s family</title><p>No internet right now. Grandma’s family will open again once you’re back online.</p>',
      { status: 503, headers: { 'content-type': 'text/html; charset=utf-8' } });
  }
}

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith('/grandma')) return; // the frame has its own worker
  if (request.mode === 'navigate') return event.respondWith(page(request));
  if (CACHEABLE_MEDIA.test(url.pathname) && !request.headers.has('range')) return event.respondWith(mediaFirst(request));
  if (url.pathname.startsWith('/api/')) {
    if (NO_CACHE_API.test(url.pathname) || request.headers.get('accept') === 'text/event-stream') return;
    return event.respondWith(networkFirst(request, API_CACHE));
  }
  if (SHELL.includes(url.pathname) || url.pathname.startsWith('/vendor/') || url.pathname.startsWith('/assets/')) {
    event.respondWith((async () => (await caches.match(request, { cacheName: SHELL_CACHE })) ?? fetch(request))());
  }
});

self.addEventListener('message', (event) => {
  // Signing out: forget cached answers and photos, so the next person on this phone sees nothing.
  if (event.data?.type === 'signed-out') {
    event.waitUntil(Promise.all([caches.delete(API_CACHE), caches.delete(MEDIA_CACHE), caches.delete(PAGE_CACHE)]));
  }
});

// Payload: declarative web push, {web_push: 8030, notification: {title, body, navigate, tag}}.
function notificationFromPayload(data) {
  const n = data?.notification ?? data ?? {};
  return {
    title: n.title || 'Grandma’s family',
    options: {
      body: n.body || '',
      tag: n.tag || undefined,
      renotify: Boolean(n.tag),
      icon: '/assets/icons/icon-192.png',
      badge: '/assets/icons/icon-192.png',
      lang: n.lang || 'en',
      data: { navigate: n.navigate || '/' },
    },
  };
}

self.addEventListener('push', (event) => {
  let data = null;
  try { data = event.data?.json(); } catch { data = { notification: { body: event.data?.text() ?? '' } }; }
  const { title, options } = notificationFromPayload(data);
  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  let target = new URL('/', self.location.origin);
  try {
    const url = new URL(event.notification.data?.navigate || '/', self.location.origin);
    if (url.origin === self.location.origin) target = url;
  } catch { /* keep "/" */ }
  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const client = windows.find((c) => new URL(c.url).origin === target.origin && !new URL(c.url).pathname.startsWith('/grandma'));
    if (client) {
      await client.focus();
      client.postMessage({ type: 'navigate', url: target.href });
      return;
    }
    await self.clients.openWindow(target.href);
  })());
});

// The browser replaced our subscription: subscribe again and tell the server.
self.addEventListener('pushsubscriptionchange', (event) => {
  event.waitUntil((async () => {
    try {
      const res = await fetch('/api/push/key', { credentials: 'same-origin' });
      const { key, publicKey } = await res.json();
      const b64 = (key ?? publicKey).replace(/-/g, '+').replace(/_/g, '/');
      const bytes = Uint8Array.from(atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4)), (c) => c.charCodeAt(0));
      const sub = await self.registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: bytes });
      const json = sub.toJSON();
      await fetch('/api/push/subscribe', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ endpoint: json.endpoint, keys: json.keys }),
      });
    } catch { /* the page re-syncs on its next launch */ }
  })());
});
