// Sessions for family members (kind 'user') and Grandma's frame (kind 'device').
// The cookie holds a random 32-byte token; only its SHA-256 is stored.
// Sessions last 400 days and slide: past half their life, the expiry is
// pushed out again (and the caller re-sets the cookie).

import { newId } from './ids.js';
import { randomToken, sha256 } from './tokens.js';

export const SESSION_COOKIE = 'gma_session';
export const SESSION_MAX_AGE_SECONDS = 34_560_000; // 400 days, Chrome's cap
const SESSION_LIFE_MS = SESSION_MAX_AGE_SECONDS * 1000;
const TOUCH_EVERY_MS = 60 * 1000; // last_seen_at is touched at most once a minute

export function createSession(db, { kind, userId = null, deviceId = null, userAgent = null }) {
  if (kind === 'user' && !userId) throw new TypeError('A user session needs a userId');
  if (kind === 'device' && !deviceId) throw new TypeError('A device session needs a deviceId');
  if (kind !== 'user' && kind !== 'device') throw new TypeError(`Unknown session kind "${kind}"`);

  const token = randomToken(32);
  const now = Date.now();
  const session = {
    id: newId(now),
    token_hash: sha256(token),
    kind,
    user_id: kind === 'user' ? userId : null,
    device_id: kind === 'device' ? deviceId : null,
    created_at: now,
    last_seen_at: now,
    expires_at: now + SESSION_LIFE_MS,
    user_agent: userAgent ? String(userAgent).slice(0, 300) : null,
  };
  db.prepare(
    `INSERT INTO sessions (id, token_hash, kind, user_id, device_id, created_at, last_seen_at, expires_at, user_agent)
     VALUES (@id, @token_hash, @kind, @user_id, @device_id, @created_at, @last_seen_at, @expires_at, @user_agent)`,
  ).run(session);
  return { token, id: session.id, expiresAt: session.expires_at };
}

function cookieOptions(reply) {
  return {
    httpOnly: true,
    secure: reply.server.config?.cookieSecure ?? true,
    sameSite: 'lax',
    path: '/',
  };
}

export function setSessionCookie(reply, token) {
  reply.setCookie(SESSION_COOKIE, token, { ...cookieOptions(reply), maxAge: SESSION_MAX_AGE_SECONDS });
  return reply;
}

export function clearSessionCookie(reply) {
  reply.clearCookie(SESSION_COOKIE, cookieOptions(reply));
  return reply;
}

export function readSessionToken(request) {
  const token = request.cookies?.[SESSION_COOKIE];
  return typeof token === 'string' && token.length >= 20 && token.length <= 200 ? token : null;
}

// Looks up a live session. Returns null when the token is unknown or expired,
// the user is removed, or the device is revoked. Otherwise returns
// { session, user, device, renewed }; when `renewed` is true the expiry was
// pushed out and the cookie should be set again.
export function loadSession(db, token) {
  if (!token) return null;
  const session = db.prepare('SELECT * FROM sessions WHERE token_hash = ?').get(sha256(token));
  if (!session) return null;
  const now = Date.now();
  if (session.expires_at <= now) {
    db.prepare('DELETE FROM sessions WHERE id = ?').run(session.id);
    return null;
  }

  let user = null;
  let device = null;
  if (session.kind === 'user') {
    user = db.prepare('SELECT * FROM users WHERE id = ?').get(session.user_id) ?? null;
    if (!user || user.status === 'removed') return null;
  } else {
    device = db.prepare('SELECT * FROM devices WHERE id = ?').get(session.device_id) ?? null;
    if (!device || device.revoked_at) return null;
  }

  let renewed = false;
  if (session.expires_at - now < SESSION_LIFE_MS / 2) {
    session.expires_at = now + SESSION_LIFE_MS;
    renewed = true;
  }
  if (renewed || now - session.last_seen_at >= TOUCH_EVERY_MS) {
    session.last_seen_at = now;
    db.prepare('UPDATE sessions SET last_seen_at = ?, expires_at = ? WHERE id = ?').run(
      now,
      session.expires_at,
      session.id,
    );
    if (device) {
      db.prepare('UPDATE devices SET last_seen_at = ? WHERE id = ?').run(now, device.id);
      device.last_seen_at = now;
    }
  }
  return { session, user, device, renewed };
}

// Signs out one session (logout).
export function destroySession(db, token) {
  if (!token) return 0;
  return db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(sha256(token)).changes;
}

export function revokeUserSessions(db, userId) {
  return db.prepare("DELETE FROM sessions WHERE kind = 'user' AND user_id = ?").run(userId).changes;
}

export function revokeDeviceSessions(db, deviceId) {
  return db.prepare("DELETE FROM sessions WHERE kind = 'device' AND device_id = ?").run(deviceId).changes;
}

// Is this session still good? (Long-lived SSE streams re-check it: a removed
// person, a revoked frame or a signed-out session ends the stream.) Read-only.
export function isSessionLive(db, sessionId, { now = Date.now() } = {}) {
  if (!sessionId) return false;
  const row = db
    .prepare(
      `SELECT s.kind, s.expires_at, u.status AS user_status, d.id AS device_row, d.revoked_at AS device_revoked_at
         FROM sessions s
         LEFT JOIN users u ON u.id = s.user_id
         LEFT JOIN devices d ON d.id = s.device_id
        WHERE s.id = ?`,
    )
    .get(sessionId);
  if (!row || row.expires_at <= now) return false;
  if (row.kind === 'user') return Boolean(row.user_status) && row.user_status !== 'removed';
  return Boolean(row.device_row) && !row.device_revoked_at;
}
