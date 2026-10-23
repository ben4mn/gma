// The web app's files and pages.
//
// - Static files come from web/ (config.webDir). HTML, JS, CSS, the service
//   workers and the manifest are revalidated on every load (no-cache, ETags),
//   so a deploy lands at once; fonts, emoji and icons under /assets/ never change
//   in place and are cached for a year; /vendor/ for 30 days. HTML is also
//   no-transform, so Cloudflare never rewrites a page (its automatic Web
//   Analytics beacon, Rocket Loader and the like would break under the CSP).
//   JS and CSS are not: no-transform would also stop Cloudflare compressing them.
// - Every family page path serves the same shell, web/index.html. Signed-out
//   visitors to a private page go to /signin?next=<path>. /signin, /confirm and
//   /join/:token are public (the service worker precaches the shell from /signin).
// - /grandma/ serves the frame, web/grandma/index.html, to a paired frame (or an
//   admin). GET /grandma (no slash, the pairing link) belongs to the frame routes.
//   The frame's service worker, /grandma/sw.js, is sent with
//   Service-Worker-Allowed: /grandma so its scope covers that link as well.
//   The frame's page is never served by the static handler (/grandma/index.html
//   has the same guard as /grandma/); its JS, CSS, sw.js and version.js stay
//   public, since the frame needs them before it is paired and they hold no data.
// - After signing in the app goes to ?next=, a path on this site only.

import path from 'node:path';
import fastifyStatic from '@fastify/static';
import { authenticate } from '../lib/guards.js';
import { stripSecretParams } from '../lib/redact.js';

const YEAR = 'public, max-age=31536000, immutable';
const MONTH = 'public, max-age=2592000';
const REVALIDATE = 'no-cache';
const REVALIDATE_HTML = 'no-cache, no-transform';

const FRAME_SHELL = '/grandma/index.html';
const FRAME_WORKER = '/grandma/sw.js';
const FRAME_WORKER_SCOPE = '/grandma';

const PRIVATE_PAGES = ['/', '/from-grandma', '/mine', '/upload', '/you'];
const PUBLIC_PAGES = ['/signin', '/confirm', '/join/:token'];
const ADMIN_PAGES = ['/admin', '/admin/*'];

function cacheControlFor(urlPath) {
  if (urlPath.startsWith('/assets/')) return YEAR;
  if (urlPath.startsWith('/vendor/')) return MONTH;
  return urlPath.endsWith('.html') ? REVALIDATE_HTML : REVALIDATE;
}

// Where to go after signing in: a path on this site (path, query and hash), or
// home for anything that would leave it (//evil.example, /\evil.example, https:…).
export function safeNextPath(next, origin) {
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

function signInRedirect(request, reply) {
  const next = safeNextPath(stripSecretParams(request.url), request.server.config.publicOrigin);
  return reply.redirect(`/signin?next=${encodeURIComponent(next)}`, 302);
}

function mayOpenFrame(request) {
  return Boolean(request.device) || request.user?.role === 'admin';
}

// The static handler's gate: the frame's page only goes out once a guarded
// route below has checked the session (sendFile passes through here too). The
// static handler itself never checks one, so it never serves the page,
// however the path is spelled.
function allowedStaticPath(pathName, root, request) {
  if (path.posix.join('/', pathName) !== FRAME_SHELL) return true;
  return mayOpenFrame(request);
}

export default async function pageRoutes(app, { config }) {
  await app.register(fastifyStatic, {
    root: config.webDir,
    prefix: '/',
    index: false,
    wildcard: true,
    dotfiles: 'ignore',
    allowedPath: allowedStaticPath,
    cacheControl: false, // set per path below
    // @fastify/static 10 passes the Fastify reply here (not the raw response).
    setHeaders(reply, filePath) {
      const rel = filePath.slice(config.webDir.length).replaceAll('\\', '/');
      reply.header('cache-control', cacheControlFor(rel));
      // The frame's worker lives in /grandma/ but controls /grandma too, the
      // pairing link the kiosk opens at boot (so it opens offline after a power cut).
      if (rel === FRAME_WORKER) reply.header('service-worker-allowed', FRAME_WORKER_SCOPE);
    },
  });

  function shell(reply) {
    return reply.header('cache-control', REVALIDATE_HTML).sendFile('index.html');
  }

  for (const url of PUBLIC_PAGES) {
    app.get(url, async (request, reply) => shell(reply));
  }

  for (const url of PRIVATE_PAGES) {
    app.get(url, async (request, reply) => {
      authenticate(request, reply);
      if (!request.user) return signInRedirect(request, reply);
      return shell(reply);
    });
  }

  for (const url of ADMIN_PAGES) {
    app.get(url, async (request, reply) => {
      authenticate(request, reply);
      if (!request.user) return signInRedirect(request, reply);
      if (request.user.role !== 'admin') return reply.redirect('/', 302);
      return shell(reply);
    });
  }

  for (const url of ['/grandma/', FRAME_SHELL]) {
    app.get(url, async (request, reply) => {
      authenticate(request, reply);
      if (!mayOpenFrame(request)) return signInRedirect(request, reply);
      return reply.header('cache-control', REVALIDATE_HTML).sendFile('grandma/index.html');
    });
  }

  app.get('/robots.txt', async (request, reply) => {
    reply.type('text/plain; charset=utf-8').header('cache-control', 'public, max-age=86400');
    return 'User-agent: *\nDisallow: /\n';
  });
}
