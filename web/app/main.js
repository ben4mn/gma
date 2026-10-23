// Boot: service worker, who's signed in, live events, then the router.
import { h, mount } from '../shared/dom.js';
import { connectEvents } from '../shared/sse.js';
import { matchRoute, navigate, startRouter } from './router.js';
import { session, loadMe } from './session.js';
import { resyncPush } from './push.js';
import { renderChrome } from './screens/shell.js';
import { familyScreen, mineScreen } from './screens/feeds.js';
import { grandmaFeedScreen } from './screens/grandma-feed.js';
import { uploadScreen, uploadInProgress } from './screens/upload.js';
import { joinScreen, signinScreen, confirmScreen } from './screens/auth.js';
import { youScreen } from './screens/you.js';
import { adminScreen } from './screens/admin.js';

const SCREENS = {
  family: familyScreen,
  grandma: grandmaFeedScreen,
  mine: mineScreen,
  upload: uploadScreen,
  you: youScreen,
  admin: adminScreen,
  join: joinScreen,
  signin: signinScreen,
  confirm: confirmScreen,
};

const live = new EventTarget();
let events = null;
let current = { key: null, cleanup: null };
const scrollMemory = new Map();
history.scrollRestoration = 'manual';

function startLive() {
  if (events) return;
  events = connectEvents({
    onEvent: (topic, payload) => live.dispatchEvent(new CustomEvent(topic, { detail: payload })),
    onReconnect: () => live.dispatchEvent(new Event('reconnect')),
  });
}

function stopLive() {
  events?.close();
  events = null;
}

function notFound(main) {
  mount(main,
    h('div', { class: 'head' }, h('h1', { class: 'title' }, 'We couldn’t find that page')),
    h('p', { class: 'body-text' }, 'It may have moved. The family photos are one tap away.'),
    h('a', { class: 'btn btn--primary', href: '/' }, 'Go to the family photos'));
}

async function render(nav = {}) {
  const key = location.pathname + location.search;
  // Opening or closing the viewer only changes the hash; the screen stays.
  if (nav.pop && key === current.key) return;
  if (current.key) scrollMemory.set(current.key, scrollY);

  const match = matchRoute(location.pathname);
  const route = match?.route;
  if (route && !route.public && !session.user) {
    const next = location.pathname === '/' ? '' : `?next=${encodeURIComponent(location.pathname + location.search)}`;
    return navigate(`/signin${next}`, { replace: true });
  }
  if (route?.admin && !session.isAdmin) return navigate('/', { replace: true });
  if (route?.name === 'signin' && session.user) return navigate('/', { replace: true });

  current.cleanup?.();
  current = { key, cleanup: null };
  const main = renderChrome(route);
  if (!route) return notFound(main);

  if (session.user) startLive();
  else stopLive();

  const ctx = {
    params: match.params,
    url: new URL(location.href),
    live,
    restoreScroll: () => { if (nav.pop) scrollTo(0, scrollMemory.get(key) ?? 0); },
    signedIn: (info) => { session.set(info); startLive(); resyncPush(); },
    rerender: () => render({}),
  };
  if (!nav.pop) scrollTo(0, 0);
  current.cleanup = SCREENS[route.name](main, ctx) ?? null;
  if (!nav.initial && !nav.pop) main.focus({ preventScroll: true });
}

async function boot() {
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/sw.js', { scope: '/' }).catch(() => {});
    navigator.serviceWorker.addEventListener('message', (event) => {
      if (event.data?.type === 'navigate' && event.data.url) {
        const url = new URL(event.data.url, location.href);
        if (url.origin === location.origin) navigate(url.pathname + url.search + url.hash);
      }
    });
    // A new version took over: reload, unless that would cut off an upload.
    let reloading = false;
    const hadController = Boolean(navigator.serviceWorker.controller);
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (!hadController || reloading || uploadInProgress()) return;
      reloading = true;
      location.reload();
    });
  }

  const main = document.getElementById('main');
  try {
    await loadMe();
  } catch (err) {
    mount(main,
      h('div', { class: 'note note--error' },
        h('p', { class: 'note-title' }, 'We can’t reach the family app right now'),
        h('p', null, err.message),
        h('button', { class: 'btn btn--primary', type: 'button', onclick: () => location.reload() }, 'Try again')));
    return;
  }
  if (session.user) resyncPush();
  addEventListener('online', () => live.dispatchEvent(new Event('reconnect')));
  startRouter(render);
}

boot();
