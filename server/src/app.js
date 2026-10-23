// buildApp(config, { db }) → a ready Fastify instance (no listen; tests use
// app.inject). It opens the database (unless one is passed in), registers the
// shared plugins, security headers, the Origin check and the JSON error
// handler, then registers every file in src/routes/.

import fs from 'node:fs';
import { IncomingMessage } from 'node:http';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import rateLimit from '@fastify/rate-limit';
import { openDb } from './db/index.js';
import { createEventHub } from './lib/events.js';
import { httpError } from './lib/guards.js';
import { redactUrl } from './lib/redact.js';
import { createStorage } from './lib/storage.js';

const ROUTES_DIR = fileURLToPath(new URL('./routes/', import.meta.url));
const STATE_CHANGING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' blob: data:",
  "media-src 'self' blob:",
  "font-src 'self'",
  "connect-src 'self'",
  "worker-src 'self'",
  "manifest-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join('; ');

const STATUS_DEFAULTS = {
  400: ['bad_request', "That request didn't look right. Please try again."],
  401: ['unauthorized', "You're signed out. Please sign in again."],
  403: ['forbidden', "You don't have access to that."],
  404: ['not_found', "We couldn't find that."],
  405: ['method_not_allowed', "That isn't something you can do here."],
  406: ['not_acceptable', "That request didn't look right. Please try again."],
  409: ['conflict', 'That changed while you were looking. Please reload and try again.'],
  413: ['too_large', 'That file is too big to send.'],
  415: ['unsupported_media_type', "That kind of file can't be sent here."],
  429: ['rate_limited', 'Too many tries. Please wait a few minutes and try again.'],
};
const SERVER_ERROR = ['server_error', 'Something went wrong on our side. Please try again in a moment.'];

function securityHeaders(config) {
  const headers = {
    'content-security-policy': CSP,
    'referrer-policy': 'no-referrer',
    'permissions-policy': 'microphone=(self), camera=()',
    'x-content-type-options': 'nosniff',
    'x-frame-options': 'DENY',
    'cross-origin-opener-policy': 'same-origin',
    'x-robots-tag': 'noindex, nofollow',
  };
  if (config.publicOrigin.startsWith('https:')) {
    headers['strict-transport-security'] = 'max-age=31536000';
  }
  return headers;
}

// Injected requests (app.inject in tests) aren't real sockets.
function isInjected(request) {
  return !(request.raw instanceof IncomingMessage);
}

function errorBody(err, statusCode) {
  if (statusCode >= 500) return { code: SERVER_ERROR[0], message: SERVER_ERROR[1] };
  if (err.expose && err.code && err.message) return { code: err.code, message: err.message };
  // Plain errors from route code: Object.assign(new Error('Readable sentence.'), { statusCode: 404, code: 'not_found' })
  if (typeof err.code === 'string' && /^[a-z][a-z0-9_]*$/.test(err.code) && err.message) {
    return { code: err.code, message: err.message };
  }
  const [code, message] = STATUS_DEFAULTS[statusCode] ?? STATUS_DEFAULTS[400];
  return { code, message };
}

// Options: `db` (an open handle the caller owns), `routesDir`, `routeOptions`
// (extra options passed to every route plugin) and `plugins` (extra plugins
// registered after the routes; tests use them for throwaway routes).
export async function buildApp(
  config,
  { db: givenDb = null, routesDir = ROUTES_DIR, routeOptions = {}, plugins = [] } = {},
) {
  const app = Fastify({
    trustProxy: config.trustProxy,
    bodyLimit: 1024 * 1024,
    logger:
      config.logLevel === 'silent'
        ? false
        : {
            level: config.logLevel,
            serializers: {
              req: (req) => ({ method: req.method, url: redactUrl(req.url), remoteAddress: req.ip }),
            },
          },
  });

  const db = givenDb ?? openDb(config.dbPath);
  const storage = createStorage(config.mediaDir);
  await storage.init();
  const events = createEventHub(db, { log: app.log });

  app.decorate('config', config);
  app.decorate('db', db);
  app.decorate('storage', storage);
  app.decorate('events', events);
  app.decorateRequest('user', null);
  app.decorateRequest('device', null);
  app.decorateRequest('session', null);

  // Long-lived SSE streams would keep close() waiting; end them first.
  app.addHook('preClose', async () => events.close());
  app.addHook('onClose', async () => {
    if (!givenDb) db.close();
  });

  // JSON bodies only (no form or text posts). Route plugins that need other
  // bodies (tus, multipart) add their own parser inside their plugin.
  app.removeContentTypeParser('text/plain');

  await app.register(cookie);
  await app.register(rateLimit, {
    global: false, // routes opt in with { config: { rateLimit: { max, timeWindow } } }
    errorResponseBuilder: () => httpError(429, ...STATUS_DEFAULTS[429]),
  });

  const headers = securityHeaders(config);
  app.addHook('onRequest', async (request, reply) => {
    reply.headers(headers);
    if (!STATE_CHANGING.has(request.method)) return;
    const origin = request.headers.origin;
    if (origin === config.publicOrigin) return;
    if (origin === undefined && config.nodeEnv === 'test' && isInjected(request)) return;
    throw httpError(403, 'bad_origin', "That request didn't come from the app. Please reload the page and try again.");
  });

  app.setErrorHandler((err, request, reply) => {
    let statusCode = err.statusCode ?? err.status ?? 500;
    if (err.validation) statusCode = 400;
    if (!Number.isInteger(statusCode) || statusCode < 400 || statusCode > 599) statusCode = 500;
    if (statusCode >= 500) request.log.error({ err }, 'Request failed');
    if (err.headers) reply.headers(err.headers);
    reply.code(statusCode).send({ error: errorBody(err, statusCode) });
  });

  app.setNotFoundHandler((request, reply) => {
    reply.code(404).send({ error: { code: STATUS_DEFAULTS[404][0], message: STATUS_DEFAULTS[404][1] } });
  });

  for (const file of fs.readdirSync(routesDir).filter((f) => f.endsWith('.js')).sort()) {
    const mod = await import(pathToFileURL(path.join(routesDir, file)).href);
    if (typeof mod.default !== 'function') throw new Error(`routes/${file} must export a default plugin function`);
    await app.register(mod.default, { ...routeOptions, config, db });
  }
  for (const plugin of plugins) await app.register(plugin, { ...routeOptions, config, db });

  await app.ready();
  return app;
}
