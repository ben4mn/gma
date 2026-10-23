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
// This file also exports the sign-in helpers the invite and /api/me routes share.

import { signInCodeEmail, sendEmail } from '../lib/email.js';
import { httpError, requireUser } from '../lib/guards.js';
import { newId } from '../lib/ids.js';
import {
  clearSessionCookie,
  createSession,
  destroySession,
  readSessionToken,
  SESSION_MAX_AGE_SECONDS,
  setSessionCookie,
} from '../lib/sessions.js';
import { DAY, HOUR, MINUTE, now } from '../lib/time.js';
import { hmac, randomDigits, randomToken, safeEqual, sha256 } from '../lib/tokens.js';
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

export const CODE_TTL_MS = 15 * MINUTE;
export const MAX_CODE_ATTEMPTS = 5;
export const CODES_PER_EMAIL_PER_HOUR = 5;
export const CODE_REQUESTS_PER_IP_PER_HOUR = 20;
export const MAX_PASSKEY_OFFERS = 3;
export const PASSKEY_OFFER_COOKIE = 'gma_passkey_offers';

const INVALID_CODE =
  "That code didn't work. Codes last 15 minutes and only the newest one works, so you can ask for a new one.";
const LINK_EXPIRED = 'That link has expired or was already used. You can ask for a new code.';
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// ---- shared helpers -------------------------------------------------------

export function publicUser(user) {
  return {
    id: user.id,
    name: user.name,
    email: user.email,
    role: user.role,
    status: user.status,
    color: user.color ?? null,
  };
}

// The visitor's address for rate limits. Behind Cloudflare the real one is in
// CF-Connecting-IP (which Cloudflare overwrites); X-Forwarded-For can be
// prefixed by the client, so it is only the fallback.
export function clientIp(request) {
  const cf = request.headers['cf-connecting-ip'];
  if (request.server.config.trustProxy && typeof cf === 'string' && cf.length > 0 && cf.length <= 64) return cf;
  return request.ip;
}

export function readEmail(value) {
  const email = typeof value === 'string' ? value.trim() : '';
  if (email.length < 3 || email.length > 254 || !EMAIL_PATTERN.test(email)) {
    throw httpError(400, 'invalid_email', 'Please enter your whole email address, like name@example.com.');
  }
  return email;
}

export function readName(value) {
  const name = typeof value === 'string' ? value.trim().replace(/\s+/g, ' ') : '';
  if (name.length < 1 || name.length > 60) {
    throw httpError(400, 'invalid_name', 'Please tell us your name (up to 60 letters).');
  }
  return name;
}

// A person who may sign in: pending (invited, not signed in yet) or active.
export function findSignInUser(db, email) {
  return db.prepare("SELECT * FROM users WHERE email = ? AND status != 'removed'").get(email) ?? null;
}

function codeHash(config, codeId, code) {
  // Keyed with SECRET_KEY and bound to the row, so equal codes never hash alike.
  return hmac(config.secretKey, `login-code:${codeId}:${code}`);
}

// Makes a new code plus confirm link for `user` and emails both. The newest
// code is the only one that works. Returns { sent: false } when this person
// already had CODES_PER_EMAIL_PER_HOUR codes in the last hour.
export async function sendSignInCode(app, user, { ip = null } = {}) {
  const { db, config } = app;
  const at = now();
  const id = newId();
  const code = randomDigits(6);
  const linkToken = randomToken(32);

  const allowed = db.transaction(() => {
    const recent = db
      .prepare('SELECT COUNT(*) AS n FROM login_codes WHERE user_id = ? AND created_at > ?')
      .get(user.id, at - HOUR).n;
    if (recent >= CODES_PER_EMAIL_PER_HOUR) return false;
    db.prepare('DELETE FROM login_codes WHERE created_at <= ?').run(at - DAY);
    db.prepare(
      `INSERT INTO login_codes (id, user_id, code_hash, link_token_hash, expires_at, attempts, used_at, created_at, ip)
       VALUES (?, ?, ?, ?, ?, 0, NULL, ?, ?)`,
    ).run(id, user.id, codeHash(config, id, code), sha256(linkToken), at + CODE_TTL_MS, at, ip);
    return true;
  })();
  if (!allowed) return { sent: false };

  const message = signInCodeEmail({
    name: user.name,
    code,
    confirmUrl: `${config.publicUrl}/confirm?t=${linkToken}`,
    minutes: CODE_TTL_MS / MINUTE,
  });
  try {
    await sendEmail(config, { to: user.email, ...message });
  } catch (err) {
    // Don't let an email that never left count against their hourly limit.
    db.prepare('DELETE FROM login_codes WHERE id = ?').run(id);
    throw err;
  }
  return { sent: true };
}

// Uses up a code row (and with it the confirm link from the same email).
function consumeLoginCode(db, codeId) {
  const result = db.prepare('UPDATE login_codes SET used_at = ? WHERE id = ? AND used_at IS NULL').run(now(), codeId);
  return result.changes === 1;
}

function newestCodeId(db, userId) {
  return db.prepare('SELECT id FROM login_codes WHERE user_id = ? ORDER BY id DESC LIMIT 1').get(userId)?.id ?? null;
}

// ---- the passkey offer ----------------------------------------------------
//
// After a sign-in without a passkey we offer to make one, once per session and
// at most MAX_PASSKEY_OFFERS times per device; never again on a device that
// signed in with one or made one. The count lives in a device cookie
// ("<count>.<session id it was last offered to>" or "done"), so it survives a
// new session on the same phone. Tampering with it only changes the nagging.

function readOfferState(request) {
  const raw = request.cookies?.[PASSKEY_OFFER_COOKIE];
  if (raw === 'done') return { done: true, count: MAX_PASSKEY_OFFERS, sessionId: null };
  const match = typeof raw === 'string' ? /^(\d)(?:\.([0-9A-HJKMNP-TV-Z]{26}))?$/.exec(raw) : null;
  if (!match) return { done: false, count: 0, sessionId: null };
  return { done: false, count: Number(match[1]), sessionId: match[2] ?? null };
}

function writeOfferState(reply, value) {
  reply.setCookie(PASSKEY_OFFER_COOKIE, value, {
    httpOnly: true,
    secure: reply.server.config.cookieSecure,
    sameSite: 'lax',
    path: '/',
    maxAge: SESSION_MAX_AGE_SECONDS,
  });
}

// True when the app should offer "Use Face ID next time" now (and counts it).
export function takePasskeyOffer(request, reply, sessionId) {
  const state = readOfferState(request);
  if (state.done || state.count >= MAX_PASSKEY_OFFERS || state.sessionId === sessionId) return false;
  writeOfferState(reply, `${state.count + 1}.${sessionId}`);
  return true;
}

export function markDeviceHasPasskey(reply) {
  writeOfferState(reply, 'done');
}

// Starts a session for `user` (activating a pending person) and sets the
// cookie. Any session this browser already had is ended first.
export function signIn(request, reply, user, { viaPasskey = false } = {}) {
  const { db } = request.server;
  const at = now();
  const session = db.transaction(() => {
    destroySession(db, readSessionToken(request));
    db.prepare("UPDATE users SET status = 'active', activated_at = ? WHERE id = ? AND status = 'pending'").run(
      at,
      user.id,
    );
    return createSession(db, { kind: 'user', userId: user.id, userAgent: request.headers['user-agent'] });
  })();
  setSessionCookie(reply, session.token);
  reply.header('cache-control', 'no-store');

  let offer = false;
  if (viaPasskey) markDeviceHasPasskey(reply);
  else offer = takePasskeyOffer(request, reply, session.id);

  const fresh = db.prepare('SELECT * FROM users WHERE id = ?').get(user.id);
  return { user: publicUser(fresh), offer_passkey: offer };
}

// ---- routes ---------------------------------------------------------------

function perIp(max, timeWindow) {
  return { rateLimit: { max, timeWindow, keyGenerator: clientIp } };
}

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
    if (!user || !consumeLoginCode(db, row.id)) throw httpError(400, 'link_expired', LINK_EXPIRED);
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
