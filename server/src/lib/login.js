// Sign-in helpers shared by the auth, invite and /api/me routes: reading a
// name or email, sending a sign-in code, starting a session and the passkey
// offer. The rules are in docs/ARCHITECTURE.md#sessions-auth-and-devices.

import { signInCodeEmail, sendEmail } from './email.js';
import { httpError } from './guards.js';
import { newId } from './ids.js';
import { shortNameOf } from './people.js';
import { createSession, destroySession, readSessionToken, SESSION_MAX_AGE_SECONDS, setSessionCookie } from './sessions.js';
import { DAY, HOUR, MINUTE, now } from './time.js';
import { hmac, randomDigits, randomToken, sha256 } from './tokens.js';

export { clientIp } from './rate-limits.js';

export const CODE_TTL_MS = 15 * MINUTE;
export const MAX_CODE_ATTEMPTS = 5;
export const CODES_PER_EMAIL_PER_HOUR = 5;
export const CODE_REQUESTS_PER_IP_PER_HOUR = 20;
export const MAX_PASSKEY_OFFERS = 3;
export const PASSKEY_OFFER_COOKIE = 'gma_passkey_offers';

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// ---- shared helpers -------------------------------------------------------

export function publicUser(user) {
  return {
    id: user.id,
    name: user.name,
    short_name: shortNameOf(user),
    email: user.email,
    role: user.role,
    status: user.status,
    color: user.color ?? null,
  };
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

// Wrong codes allowed per person per day, across all their codes. Past it no
// code is sent or accepted for that email until the day is over, so a slow
// guesser who knows an address never gets more than this many tries a day.
export const MAX_FAILED_CODES_PER_DAY = 15;

export function failedCodesToday(db, userId, at = now()) {
  const row = db
    .prepare(
      `SELECT COALESCE(SUM(attempts), 0) - COALESCE(SUM(used_at IS NOT NULL AND attempts > 0), 0) AS failed
       FROM login_codes WHERE user_id = ? AND created_at > ?`,
    )
    .get(userId, at - DAY);
  return row.failed;
}

export function codeHash(config, codeId, code) {
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
    if (failedCodesToday(db, user.id, at) >= MAX_FAILED_CODES_PER_DAY) return false;
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
export function consumeLoginCode(db, codeId) {
  const result = db.prepare('UPDATE login_codes SET used_at = ? WHERE id = ? AND used_at IS NULL').run(now(), codeId);
  return result.changes === 1;
}

// Uses up only the confirm link of a code row: the code in the same email
// keeps working. Someone who taps the link in Mail signs Safari in, and the
// app on their Home Screen (its own cookie jar) can still take the code.
export function consumeLoginLink(db, codeId) {
  const result = db
    .prepare("UPDATE login_codes SET link_token_hash = 'used:' || id WHERE id = ? AND used_at IS NULL AND link_token_hash NOT LIKE 'used:%'")
    .run(codeId);
  return result.changes === 1;
}

export function newestCodeId(db, userId) {
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
