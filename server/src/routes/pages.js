// The web app's files and pages.
//
// - Static files come from web/ (config.webDir). HTML, JS, CSS, the service
//   workers and the manifest are revalidated on every load (no-cache, ETags),
//   so a deploy lands at once; fonts, emoji and icons under /assets/ never change
//   in place and are cached for a year; /vendor/ for 30 days.
// - Every family page path serves the same shell, web/index.html. Signed-out
//   visitors to a private page go to /signin?next=<path>. /signin, /confirm and
//   /join/:token are public (the service worker precaches the shell from /signin).
// - /grandma/ serves the frame, web/grandma/index.html, to a paired frame (or an
//   admin). GET /grandma (no slash, the pairing link) belongs to the frame routes.

import fastifyStatic from '@fastify/static';
import { authenticate } from '../lib/guards.js';
import { stripSecretParams } from '../lib/redact.js';

const YEAR = 'public, max-age=31536000, immutable';
const MONTH = 'public, max-age=2592000';
const REVALIDATE = 'no-cache';

const PRIVATE_PAGES = ['/', '/from-grandma', '/mine', '/upload', '/you'];
const PUBLIC_PAGES = ['/signin', '/confirm', '/join/:token'];
const ADMIN_PAGES = ['/admin', '/admin/*'];

function cacheControlFor(urlPath) {
  if (urlPath.startsWith('/assets/')) return YEAR;
  if (urlPath.startsWith('/vendor/')) return MONTH;
  return REVALIDATE;
}

function signInRedirect(request, reply) {
  return reply.redirect(`/signin?next=${encodeURIComponent(stripSecretParams(request.url))}`, 302);
}

export default async function pageRoutes(app, { config }) {
  await app.register(fastifyStatic, {
    root: config.webDir,
    prefix: '/',
    index: false,
    wildcard: true,
    dotfiles: 'ignore',
    cacheControl: false, // set per path below
    // @fastify/static 10 passes the Fastify reply here (not the raw response).
    setHeaders(reply, filePath) {
      const rel = filePath.slice(config.webDir.length).replaceAll('\\', '/');
      reply.header('cache-control', cacheControlFor(rel));
    },
  });

  function shell(reply) {
    return reply.header('cache-control', REVALIDATE).sendFile('index.html');
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

  app.get('/grandma/', async (request, reply) => {
    authenticate(request, reply);
    if (!request.device && request.user?.role !== 'admin') return signInRedirect(request, reply);
    return reply.header('cache-control', REVALIDATE).sendFile('grandma/index.html');
  });

  app.get('/robots.txt', async (request, reply) => {
    reply.type('text/plain; charset=utf-8').header('cache-control', 'public, max-age=86400');
    return 'User-agent: *\nDisallow: /\n';
  });
}
