// Family sign-in: email codes, the /confirm link, passkeys and sign-out.
// The rules are in docs/ARCHITECTURE.md#sessions-auth-and-devices.
//
//   POST /api/auth/code/request        {email}          always 200
//   POST /api/auth/code/verify         {email, code}    → {user, offer_passkey}
//   POST /api/auth/link/confirm        {token}          → {user, offer_passkey}
//   POST /api/auth/passkey/register/options  (user)     → creation options JSON
//   POST /api/auth/passkey/register/verify   (user)     → {passkey, passkeys}
//   POST /api/auth/passkey/login/options                → request options JSON
//   POST /api/auth/passkey/login/verify                 → {user, offer_passkey: false}
//   POST /api/auth/logout               (user)          → {ok}
//
// The shared sign-in helpers (signIn, sendSignInCode, …) live in lib/login.js.

import { httpError, requireUser } from '../lib/guards.js';
import {
  CODE_REQUESTS_PER_IP_PER_HOUR,
  codeHash,
  consumeLoginCode,
  consumeLoginLink,
  failedCodesToday,
  MAX_FAILED_CODES_PER_DAY,
  findSignInUser,
  markDeviceHasPasskey,
  MAX_CODE_ATTEMPTS,
  newestCodeId,
  readEmail,
  sendSignInCode,
  signIn,
} from '../lib/login.js';
import { clientIp, perIp } from '../lib/rate-limits.js';
import { clearSessionCookie, destroySession, readSessionToken } from '../lib/sessions.js';
import { now } from '../lib/time.js';
import { safeEqual, sha256 } from '../lib/tokens.js';
import {
  countPasskeys,
  createLoginOptions,
  createRegistrationOptions,
  publicPasskey,
  setChallengeCookie,
  takeChallengeCookie,
  verifyLogin,
  verifyRegistration,
} from '../lib/webauthn.js';

const INVALID_CODE =
  "That code didn't work. Codes last 15 minutes and only the newest one works, so you can ask for a new one.";
const LINK_EXPIRED = 'That link has expired or was already used. You can ask for a new code.';

export default async function authRoutes(app, { config, db }) {
  app.post(
    '/api/auth/code/request',
    { config: perIp(CODE_REQUESTS_PER_IP_PER_HOUR, '1 hour') },
    async (request) => {
      const email = readEmail(request.body?.email);
      const user = findSignInUser(db, email);
      if (user) {
        // Not awaited: sending takes a moment, and an answer that came back
        // slower for real accounts would tell a stranger who has one.
        sendSignInCode(app, user, { ip: clientIp(request) })
          .then(({ sent }) => {
            if (!sent) request.log.info({ userId: user.id }, 'Sign-in code not sent: hourly limit reached');
          })
          .catch((err) => request.log.error({ err, userId: user.id }, 'Could not send a sign-in code'));
      }
      return { ok: true };
    },
  );

  app.post('/api/auth/code/verify', { config: perIp(30, '15 minutes') }, async (request, reply) => {
    const email = readEmail(request.body?.email);
    const code = String(request.body?.code ?? '').replace(/\s+/g, '');
    if (!/^\d{6}$/.test(code)) {
      throw httpError(400, 'invalid_code', 'Please type the 6 numbers from the email.');
    }
    // One answer for every failure (no account, no code, wrong, expired, used,
    // too many tries) so it can't be used to find out who has an account.
    const user = findSignInUser(db, email);
    const codeId = user ? newestCodeId(db, user.id) : null;
    const row = codeId ? db.prepare('SELECT * FROM login_codes WHERE id = ?').get(codeId) : null;
    if (!row) throw httpError(400, 'invalid_code', INVALID_CODE);
    if (failedCodesToday(db, user.id) >= MAX_FAILED_CODES_PER_DAY) {
      request.log.warn({ userId: user.id }, 'Sign-in code refused: too many wrong codes today');
      throw httpError(400, 'invalid_code', INVALID_CODE);
    }

    const counted = db
      .prepare(
        `UPDATE login_codes SET attempts = attempts + 1
         WHERE id = ? AND used_at IS NULL AND expires_at > ? AND attempts < ? RETURNING attempts`,
      )
      .get(row.id, now(), MAX_CODE_ATTEMPTS);
    if (!counted || !safeEqual(codeHash(config, row.id, code), row.code_hash) || !consumeLoginCode(db, row.id)) {
      throw httpError(400, 'invalid_code', INVALID_CODE);
    }
    return signIn(request, reply, user);
  });

  // The /confirm page's button. GET /confirm only shows the page, so a mail
  // scanner that opens the link can't use it up.
  app.post('/api/auth/link/confirm', { config: perIp(30, '15 minutes') }, async (request, reply) => {
    const token = request.body?.token;
    if (typeof token !== 'string' || token.length < 20 || token.length > 200) {
      throw httpError(400, 'link_expired', LINK_EXPIRED);
    }
    const row = db.prepare('SELECT * FROM login_codes WHERE link_token_hash = ?').get(sha256(token));
    const valid = row && !row.used_at && row.expires_at > now() && newestCodeId(db, row.user_id) === row.id;
    const user = valid ? db.prepare("SELECT * FROM users WHERE id = ? AND status != 'removed'").get(row.user_id) : null;
    if (!user || !consumeLoginLink(db, row.id)) throw httpError(400, 'link_expired', LINK_EXPIRED);
    return signIn(request, reply, user);
  });

  app.post('/api/auth/passkey/register/options', { preHandler: requireUser }, async (request, reply) => {
    const { options, challengeId } = await createRegistrationOptions(db, config, request.user);
    setChallengeCookie(reply, config, challengeId);
    reply.header('cache-control', 'no-store');
    return options;
  });

  app.post('/api/auth/passkey/register/verify', { preHandler: requireUser }, async (request, reply) => {
    const challengeId = takeChallengeCookie(request, reply, config);
    const row = await verifyRegistration(db, config, {
      challengeId,
      user: request.user,
      response: request.body,
      log: request.log,
    });
    markDeviceHasPasskey(reply);
    return { passkey: publicPasskey(row), passkeys: countPasskeys(db, request.user.id) };
  });

  app.post('/api/auth/passkey/login/options', { config: perIp(30, '1 minute') }, async (request, reply) => {
    const { options, challengeId } = await createLoginOptions(db, config);
    setChallengeCookie(reply, config, challengeId);
    reply.header('cache-control', 'no-store');
    return options;
  });

  app.post('/api/auth/passkey/login/verify', { config: perIp(30, '1 minute') }, async (request, reply) => {
    const challengeId = takeChallengeCookie(request, reply, config);
    const { user } = await verifyLogin(db, config, { challengeId, response: request.body, log: request.log });
    return signIn(request, reply, user, { viaPasskey: true });
  });

  app.post('/api/auth/logout', { preHandler: requireUser }, async (request, reply) => {
    destroySession(db, readSessionToken(request));
    clearSessionCookie(reply);
    return { ok: true };
  });
}
