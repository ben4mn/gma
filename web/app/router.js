// Every family page is a real path served by the same shell, so links work
// from email, from a push and after a reload. matchRoute is pure; start()
// wires it to the History API.

export const ROUTES = [
  { name: 'family', path: '/', tab: 'family' },
  { name: 'grandma', path: '/from-grandma', tab: 'grandma' },
  { name: 'mine', path: '/mine', tab: 'mine' },
  { name: 'upload', path: '/upload' },
  { name: 'you', path: '/you' },
  { name: 'admin', path: '/admin', admin: true },
  { name: 'admin', path: '/admin/:section', admin: true },
  { name: 'join', path: '/join/:token', public: true },
  { name: 'signin', path: '/signin', public: true },
  { name: 'confirm', path: '/confirm', public: true },
];

const compiled = ROUTES.map((route) => ({
  route,
  parts: route.path.split('/').filter(Boolean),
}));

export function normalizePath(pathname) {
  const trimmed = String(pathname || '/').replace(/\/{2,}/g, '/').replace(/\/+$/, '');
  return trimmed === '' ? '/' : trimmed;
}

/** → { route, params } for a family path, or null when the path isn't one of ours. */
export function matchRoute(pathname) {
  const parts = normalizePath(pathname).split('/').filter(Boolean);
  for (const { route, parts: pattern } of compiled) {
    if (pattern.length !== parts.length) continue;
    const params = {};
    const ok = pattern.every((seg, i) => {
      if (seg.startsWith(':')) {
        try { params[seg.slice(1)] = decodeURIComponent(parts[i]); } catch { return false; }
        return params[seg.slice(1)] !== '';
      }
      return seg === parts[i];
    });
    if (ok) return { route, params };
  }
  return null;
}

/**
 * Where to go after signing in (?next=): a path on this site, or '/' for
 * anything that would leave it (//evil.example, /\evil.example, https:…).
 * The server checks the same way when it writes the parameter.
 */
/** The join and confirm pages never need to know who is signed in (asking would log a 401). */
export function needsSession(pathname) {
  const path = normalizePath(pathname);
  return !(path === '/confirm' || path.startsWith('/join/'));
}

export function safeNext(next, origin) {
  if (typeof next !== 'string' || next === '') return '/';
  try {
    const url = new URL(next, origin);
    const out = url.pathname + url.search + url.hash;
    // A dot segment can collapse into a same-origin path that starts with '//'
    // ('/x/..//evil.example'), which the browser would read as another host.
    return url.origin === origin && !out.startsWith('//') ? out : '/';
  } catch {
    return '/';
  }
}

/** Should a click on this URL stay inside the app? (Media, the API and Grandma's frame never do.) */
export function isAppLink(url, origin) {
  if (url.origin !== origin) return false;
  if (/^\/(api|media|grandma|assets|vendor)(\/|$)/.test(url.pathname)) return false;
  return matchRoute(url.pathname) !== null;
}

let onChange = () => {};

export function navigate(to, { replace = false, state = null } = {}) {
  const url = new URL(to, location.href);
  const same = url.pathname === location.pathname && url.search === location.search && url.hash === location.hash;
  if (replace || same) history.replaceState(state, '', url);
  else history.pushState(state, '', url);
  onChange({ push: !replace && !same });
}

export function startRouter(render) {
  onChange = render;
  addEventListener('popstate', () => render({ pop: true }));
  document.addEventListener('click', (event) => {
    if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    const a = event.target.closest?.('a[href]');
    if (!a || a.target || a.hasAttribute('download')) return;
    const url = new URL(a.href, location.href);
    if (!isAppLink(url, location.origin)) return;
    event.preventDefault();
    navigate(url.pathname + url.search + url.hash);
  });
  render({ initial: true });
}
