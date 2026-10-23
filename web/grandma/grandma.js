// Grandma's frame. GET /api/frame/state drives every screen; SSE says when to
// fetch it again; the outbox carries what she sends; the service worker keeps
// photos showing when the internet is down. She never sees an error.
import { VERSION } from './version.js';
import { createApi } from './lib/api.js';
import { connectLive } from './lib/live.js';
import { createOutbox, idbStore, memoryStore } from './lib/outbox.js';
import { slideshowItems, groupIntoCards, familyPhotoUrl, normalizeList } from './lib/cards.js';
import { formatTime, formatDate, isNightAt, whenLabel, zonedParts, parseHm } from './lib/time.js';
import { shouldGoHome, shouldRest, canReload, canRedrawHome } from './lib/idle.js';
import { icon } from './lib/dom.js';
import { renderHome } from './screens/home.js';
import { renderItem } from './screens/item.js';
import { renderVoice } from './screens/voice.js';
import { renderRest } from './screens/night.js';

const params = new URLSearchParams(location.search);
const FIXTURE = params.get('fixture') === '1';
const FIXTURE_STATE = FIXTURE ? params.get('state') ?? '' : '';
const DEFAULT_SETTINGS = { night_start: '21:00', night_end: '07:00', timezone: 'America/Chicago' };
const STATE_REFRESH_MS = 5 * 60_000;
const HEARTBEAT_MS = 60_000;
const SEEN_KEY = 'gma-frame-seen';

const api = createApi({ fixture: FIXTURE });
const outbox = createOutbox({ store: FIXTURE || !('indexedDB' in globalThis) ? memoryStore() : idbStore(), send: api.send });

const els = {
  root: document.documentElement,
  home: document.getElementById('home-btn'),
  status: document.getElementById('status'),
  date: document.getElementById('clock-date'),
  time: document.getElementById('clock-time'),
  screen: document.getElementById('screen'),
  rest: document.getElementById('rest-layer'),
};

let raw = null;            // the last state from the server (or the fixture)
let clockOffset = 0;       // server time − this machine's time
let screenName = null;
let screen = null;
let homeSignature = '';
let night = false;
let resting = false;
let rest = null;
let offline = false;
let onlineSince = Date.now();
let lastTouch = Date.now();
let busy = false;
let reloadPending = false;
let wakeLock = null;
const seen = loadSeen();

// ---------- state ----------

function settings() {
  return { ...DEFAULT_SETTINGS, ...(raw?.settings ?? {}) };
}

function view() {
  const slideshow = slideshowItems(raw?.slideshow);
  return {
    settings: settings(),
    presets: (raw?.presets ?? [])
      .filter((p) => p && p.id && p.active !== 0 && p.active !== false)
      .sort((a, b) => (a.sort ?? 0) - (b.sort ?? 0)),
    slideshow,
    cards: groupIntoCards(raw?.new, seen),
    familyPhoto: familyPhotoUrl(raw?.family_photo, slideshow),
  };
}

const clockNow = () => Date.now() + clockOffset;

async function refresh() {
  try {
    const { state, cached } = await api.getState();
    if (!cached && Number.isFinite(state.now) && !FIXTURE) clockOffset = state.now - Date.now();
    raw = state;
    setOffline(cached);
  } catch (err) {
    // keep showing what we have; a 401 (device revoked) is Ben's to fix, not Grandma's
    if (!err.status) setOffline(true);
  }
  if (screenName === 'home') renderHomeIfChanged();
  warmCache();
}

let refreshTimer = null;
function refreshSoon(ms = 1500) {
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(refresh, ms);
}

// ---------- screens ----------

const ctx = {
  get state() { return view(); },
  get night() { return night; },
  slideIndex: 0,
  when: (ms) => whenLabel(ms, clockNow(), settings().timezone),
  go,
  home: () => go('home'),
  send(kind, payload) { outbox.add(kind, payload).catch(() => {}); },
  markSeen(id) {
    if (seen.has(id)) return;
    seen.add(id);
    saveSeen();
    outbox.add('seen', { item_ids: [id] }).catch(() => {});
  },
  setBusy(value) {
    busy = value;
    if (!value) lastTouch = Date.now(); // the quiet time starts when the video or recording ends
  },
};

const SCREENS = { home: renderHome, item: renderItem, voice: renderVoice };

function go(name, screenParams = {}) {
  screen?.destroy?.();
  busy = false;
  screenName = name;
  screen = SCREENS[name](ctx, screenParams);
  if (name === 'home') { homeSignature = signature(); homeStale = false; }
  els.screen.replaceChildren(screen.el);
  els.root.dataset.screen = name;
  updateChrome();
}

function signature() {
  const v = view();
  return JSON.stringify([v.slideshow.map((i) => i.id + i.display), v.cards.map((c) => c.items.map((i) => i.id)), v.familyPhoto]);
}

// New cards wait until Home has been left alone for a while (the one-second
// tick tries again), so nothing jumps under Grandma's finger.
let homeStale = false; // new cards are waiting for Home to be left alone
function renderHomeIfChanged() {
  if (signature() === homeSignature) { homeStale = false; return; }
  if (!FIXTURE && !canRedrawHome({ screen: screenName, lastTouch, now: Date.now(), busy })) { homeStale = true; return; }
  go('home');
}

// ---------- the header, night and the resting screen ----------

function updateChrome() {
  const onHome = screenName === 'home';
  els.home.toggleAttribute('aria-current', onHome);
  if (onHome) els.home.setAttribute('aria-current', 'page');
  els.root.dataset.theme = night ? 'night' : 'day';
  els.root.toggleAttribute('data-resting', resting);
  let line = null;
  if (offline) line = { icon: 'offline', text: 'No internet right now. Your saved photos keep showing.' };
  else if (night && onHome && !resting) line = { icon: 'moon', text: 'Good evening. The slideshow rests until morning.' };
  els.status.hidden = !line;
  if (line) els.status.replaceChildren(icon(line.icon), document.createTextNode(line.text));
  els.status.dataset.kind = line?.icon ?? '';
}

function tickClock() {
  const now = clockNow();
  const tz = settings().timezone;
  const time = formatTime(now, tz);
  const date = formatDate(now, tz);
  if (els.time.textContent !== time) els.time.textContent = time;
  if (els.date.textContent !== date) els.date.textContent = date;
  rest?.setClock(time, date);
}

function setNight(value) {
  if (value === night) return;
  night = value;
  if (screenName === 'home') screen.setPaused?.(night);
  if (!night) setResting(false);
  updateChrome();
  syncWakeLock();
}

function setResting(value) {
  if (value === resting) return;
  resting = value;
  if (resting) {
    if (screenName !== 'home') go('home');
    rest = renderRest({ item: screen.currentItem?.() ?? null, onWake: wake });
    els.rest.replaceChildren(rest.el);
    tickClock();
  } else {
    rest = null;
    els.rest.replaceChildren();
  }
  updateChrome();
}

function wake() {
  lastTouch = Date.now();
  setResting(false);
}

function setOffline(value) {
  if (value === offline) return;
  offline = value;
  if (!offline) onlineSince = Date.now();
  updateChrome();
}

// ---------- the one-second tick: clock, night, idle, waiting reloads ----------

function tick() {
  tickClock();
  const now = Date.now();
  setNight(isNightAt(clockNow(), settings()));
  const s = { screen: screenName, lastTouch, now, busy };
  if (shouldGoHome(s)) go('home');
  else if (homeStale && screenName === 'home') renderHomeIfChanged();
  if (shouldRest({ ...s, night, resting, screen: screenName })) setResting(true);
  if (reloadPending && (resting || canReload(s))) location.reload();
}

// ---------- kiosk hygiene ----------

function kiosk() {
  for (const type of ['contextmenu', 'selectstart', 'dragstart', 'gesturestart', 'dblclick']) {
    document.addEventListener(type, (e) => e.preventDefault());
  }
  document.addEventListener('wheel', (e) => { if (e.ctrlKey) e.preventDefault(); }, { passive: false });
  document.addEventListener('touchmove', (e) => { if (e.touches.length > 1) e.preventDefault(); }, { passive: false });
  document.addEventListener('pointerdown', () => { lastTouch = Date.now(); }, { capture: true });
  els.home.addEventListener('click', () => {
    if (resting) wake(); // the first tap only wakes
    else if (screenName !== 'home') go('home');
  });
  document.addEventListener('visibilitychange', syncWakeLock);
}

async function syncWakeLock() {
  const want = !night && document.visibilityState === 'visible';
  if (want && !wakeLock && navigator.wakeLock) {
    try {
      wakeLock = await navigator.wakeLock.request('screen');
      wakeLock.addEventListener('release', () => { wakeLock = null; });
    } catch { /* not allowed right now (e.g. hidden); tried again next minute */ }
  } else if (!want && wakeLock) {
    wakeLock.release().catch(() => {});
    wakeLock = null;
  }
}

// ---------- seen items (remembered here too, so cards don't come back offline) ----------

function loadSeen() {
  try { return new Set(JSON.parse(localStorage.getItem(SEEN_KEY) ?? '[]')); } catch { return new Set(); }
}

function saveSeen() {
  try { localStorage.setItem(SEEN_KEY, JSON.stringify([...seen].slice(-1000))); } catch { /* storage full: the server still knows */ }
}

// ---------- live updates, heartbeat, service worker, cache ----------

function startLive() {
  connectLive({
    onOpen: () => { setOffline(false); refreshSoon(0); },
    onEvent: (topic, data) => {
      if (topic === 'frame.reload' || topic === 'reload') { reloadPending = true; return; }
      if (topic === 'item.removed') {
        const id = data?.item_id ?? data?.id;
        if (id && screenName === 'item' && screen.removed?.(id)) go('home');
        refreshSoon(0);
        return;
      }
      if (topic === 'resync') { refreshSoon(0); return; } // missed too much while away: fetch it all again
      if (topic === 'item.ready' || topic === 'settings.changed') refreshSoon();
    },
  });
}

async function heartbeat() {
  const counts = await outbox.refreshCounts().catch(() => outbox.counts);
  const res = await api.heartbeat({
    version: VERSION,
    online_since: onlineSince,
    outbox_pending: counts.pending,
    outbox_failed: counts.failed,
  });
  if (res.status === 0) setOffline(true);
  else if (res.status < 500) setOffline(false);
}

// The worker's scope is /grandma (no slash), so it also answers the pairing
// link /grandma?device=… the kiosk opens at boot: after a power cut with no
// internet that link still opens the saved frame. The server allows the wider
// scope with a Service-Worker-Allowed header on the script.
const SW_URL = new URL('./sw.js', import.meta.url);
const SW_SCOPE = new URL('./', import.meta.url).pathname.replace(/\/$/, '');

async function startServiceWorker() {
  if (!('serviceWorker' in navigator)) return;
  try {
    const hadController = navigator.serviceWorker.controller?.scriptURL === SW_URL.href;
    const reg = await navigator.serviceWorker.register(SW_URL, { scope: SW_SCOPE, type: 'module' });
    // a new version took over: reload when Grandma is on Home and not touching it
    navigator.serviceWorker.addEventListener('controllerchange', () => { if (hadController) reloadPending = true; });
    setInterval(() => reg.update().catch(() => {}), 60 * 60_000);
    // frames set up before the wider scope still hold a /grandma/ registration,
    // which would keep winning for /grandma/ pages: retire it
    for (const old of await navigator.serviceWorker.getRegistrations()) {
      if (new URL(old.scope).pathname === `${SW_SCOPE}/`) old.unregister().catch(() => {});
    }
  } catch { /* the frame still works without offline support */ }
  navigator.storage?.persist?.().catch(() => {});
}

let warmRun = 0;
/** Fetch the slideshow and new posters through the service worker, so they are saved for offline. */
async function warmCache() {
  if (FIXTURE || !navigator.serviceWorker?.controller || offline) return;
  const run = ++warmRun;
  const urls = new Set();
  for (const i of slideshowItems(raw?.slideshow).slice(0, 300)) urls.add(i.display);
  for (const i of normalizeList((raw?.new ?? []).flatMap((c) => c?.items ?? [c]))) urls.add(i.kind === 'video' ? i.poster : i.display);
  for (const url of urls) {
    if (run !== warmRun || offline) return;
    if (!url) continue;
    await fetch(url, { priority: 'low', credentials: 'same-origin' }).then((r) => r.blob()).catch(() => {});
  }
}

// ---------- fixture mode: screenshots without a server ----------

function fixtureClock() {
  const at = params.get('at') ?? (FIXTURE_STATE.startsWith('night') ? '21:30' : null);
  const base = Number.isFinite(raw?.now) ? raw.now : Date.now();
  let target = base;
  const minutes = parseHm(at);
  if (minutes != null) {
    const p = zonedParts(base, settings().timezone);
    target = base + (minutes - (p.hour * 60 + p.minute)) * 60_000;
  }
  clockOffset = target - Date.now();
}

function openFixtureScreen() {
  const v = view();
  const items = [...v.cards.flatMap((c) => c.items), ...v.slideshow];
  const first = (kind) => items.find((i) => i.kind === kind) ?? items[0];
  const said = params.get('said');
  switch (FIXTURE_STATE) {
    case 'item': return go('item', { items: v.slideshow, index: Number(params.get('i') ?? 0) });
    case 'video': return go('item', { items: [first('video')], index: 0 });
    case 'presets': return go('item', { items: [first('video')], index: 0, view: 'presets' });
    case 'sent': return go('item', {
      items: [first('video')], index: 0, view: 'sent', reaction: params.get('r') ?? 'love',
      preset: said ? v.presets.find((p) => p.text === said) ?? { id: 'x', text: said } : null,
    });
    case 'voice': return go('voice');
    case 'recording': return go('voice', { view: 'recording' });
    case 'voice-sent': return go('voice', { view: 'sent' });
    default: return go('home');
  }
}

// ---------- boot ----------

async function boot() {
  kiosk();
  await refresh();
  if (FIXTURE) {
    fixtureClock();
    if (FIXTURE_STATE === 'offline') offline = true;
    // fixture screenshots hold still: no timers move the screen
    window.__gmaFixture = { ctx, go };
  }
  night = isNightAt(clockNow(), settings());
  resting = false;
  tickClock();
  if (FIXTURE) openFixtureScreen(); else go('home');
  if (night && (screenName === 'home') && FIXTURE_STATE !== 'night-awake') setResting(true);
  updateChrome();
  if (FIXTURE) return;

  setInterval(tick, 1000);
  outbox.start(window);
  startLive();
  heartbeat();
  setInterval(heartbeat, HEARTBEAT_MS);
  setInterval(refresh, STATE_REFRESH_MS);
  setInterval(syncWakeLock, 60_000);
  window.addEventListener('online', () => refreshSoon(0));
  window.addEventListener('offline', () => setOffline(true));
  syncWakeLock();
  startServiceWorker();
}

boot();
