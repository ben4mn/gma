// Web push subscriptions for family members.
//
//   GET  /api/push/key          the VAPID public key the browser subscribes with
//   POST /api/push/subscribe    { endpoint, keys: { p256dh, auth } }  (upsert by endpoint)
//   POST /api/push/unsubscribe  { endpoint }
//   POST /api/push/test         a test notification to this person's phones
//
// Route options: `pushSender` replaces web-push's sendNotification (tests).

import { httpError, requireUser } from '../lib/guards.js';
import { newId } from '../lib/ids.js';
import { pushConfigured, sendToUser } from '../lib/push.js';
import { now } from '../lib/time.js';

const MAX_SUBSCRIPTIONS_PER_USER = 10;

// The server POSTs to whatever endpoint is stored, so only the browsers' own
// push services are accepted (otherwise a subscription could aim the server at
// an internal address).
const PUSH_SERVICE_HOSTS = [
  'fcm.googleapis.com', // Chrome, Edge on Android, Samsung Internet, Opera, Brave
  'android.googleapis.com',
  'push.services.mozilla.com', // Firefox
  'push.apple.com', // Safari and iOS home-screen apps (web.push.apple.com)
  'notify.windows.com', // Edge on Windows
];

export function isPushServiceUrl(endpoint) {
  let url;
  try {
    url = new URL(endpoint);
  } catch {
    return false;
  }
  if (url.protocol !== 'https:' || url.username || url.password || url.port) return false;
  const host = url.hostname.toLowerCase();
  return PUSH_SERVICE_HOSTS.some((allowed) => host === allowed || host.endsWith(`.${allowed}`));
}

function decodedLength(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]+={0,2}$/.test(value)) return -1;
  return Buffer.from(value.replace(/=+$/, ''), 'base64url').length;
}

const NOT_VALID = () =>
  httpError(400, 'bad_subscription', "Notifications couldn't be turned on for this phone. Please try again.");

function parseSubscription(body) {
  const endpoint = body?.endpoint;
  const keys = body?.keys ?? {};
  if (typeof endpoint !== 'string' || endpoint.length > 2048) throw NOT_VALID();
  if (!isPushServiceUrl(endpoint)) {
    throw httpError(
      400,
      'unsupported_push_service',
      "This browser's notifications aren't supported. Try Safari on iPhone, or Chrome or Firefox.",
    );
  }
  // RFC 8291: p256dh is an uncompressed P-256 point (65 bytes), auth is 16 bytes.
  if (decodedLength(keys.p256dh) !== 65 || decodedLength(keys.auth) !== 16) throw NOT_VALID();
  return { endpoint, p256dh: keys.p256dh, auth: keys.auth };
}

// 409 rather than 503: the app's error handler replaces every 5xx message with
// a generic one, and this sentence is the useful part.
function requirePushConfigured(config) {
  if (!pushConfigured(config)) {
    throw httpError(409, 'push_unavailable', "Notifications aren't set up on the server yet. Ben can turn them on.");
  }
}

export default async function pushRoutes(app, { config, db, pushSender = undefined }) {
  const upsert = db.prepare(
    `INSERT INTO push_subscriptions (id, user_id, endpoint, p256dh, auth, user_agent, created_at, last_success_at, failures)
     VALUES (@id, @user_id, @endpoint, @p256dh, @auth, @user_agent, @created_at, NULL, 0)
     ON CONFLICT (endpoint) DO UPDATE SET
       user_id = excluded.user_id, p256dh = excluded.p256dh, auth = excluded.auth,
       user_agent = excluded.user_agent, failures = 0`,
  );
  const trim = db.prepare(
    `DELETE FROM push_subscriptions WHERE user_id = ? AND id NOT IN (
       SELECT id FROM push_subscriptions WHERE user_id = ? ORDER BY created_at DESC, id DESC LIMIT ?)`,
  );
  const remove = db.prepare('DELETE FROM push_subscriptions WHERE endpoint = ? AND user_id = ?');
  const countForUser = db.prepare('SELECT COUNT(*) AS n FROM push_subscriptions WHERE user_id = ?');

  app.get('/api/push/key', { preHandler: requireUser }, async (request, reply) => {
    requirePushConfigured(config);
    reply.header('cache-control', 'no-cache');
    return { key: config.vapidPublicKey };
  });

  app.post('/api/push/subscribe', { preHandler: requireUser }, async (request) => {
    const sub = parseSubscription(request.body);
    const userId = request.user.id;
    db.transaction(() => {
      // A shared phone that changes hands moves its subscription to whoever signed in.
      upsert.run({
        id: newId(),
        user_id: userId,
        ...sub,
        user_agent: request.headers['user-agent'] ? String(request.headers['user-agent']).slice(0, 300) : null,
        created_at: now(),
      });
      trim.run(userId, userId, MAX_SUBSCRIPTIONS_PER_USER);
    })();
    return { ok: true };
  });

  app.post('/api/push/unsubscribe', { preHandler: requireUser }, async (request) => {
    const endpoint = request.body?.endpoint;
    if (typeof endpoint !== 'string' || endpoint.length > 2048) throw NOT_VALID();
    const removed = remove.run(endpoint, request.user.id).changes;
    return { ok: true, removed };
  });

  app.post(
    '/api/push/test',
    { preHandler: requireUser, config: { rateLimit: { max: 10, timeWindow: '10 minutes' } } },
    async (request) => {
      requirePushConfigured(config);
      const userId = request.user.id;
      if (countForUser.get(userId).n === 0) {
        throw httpError(
          409,
          'no_subscription',
          "Notifications aren't on for this phone yet. Turn them on first, then try again.",
        );
      }
      const result = await sendToUser(
        db,
        config,
        userId,
        {
          web_push: 8030,
          notification: {
            title: 'Notifications are on',
            body: "This is how you'll hear when Grandma sends you something.",
            navigate: `${config.publicOrigin}/you`,
            tag: 'gma-test',
          },
        },
        { sender: pushSender, log: request.log },
      );
      // ok: false means no phone took it; the app says so in its own words.
      return { ok: result.sent > 0, sent: result.sent, failed: result.failed };
    },
  );
}
