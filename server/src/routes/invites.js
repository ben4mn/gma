// Opening an invite link: /join/<token> asks these routes about the invite.
//
//   GET  /api/invites/:token          → {valid, name, email, emailed, reason}
//   POST /api/invites/:token/accept   {name, email}
//        → {signed_in: true, user, offer_passkey}   the app emailed the invite to that address
//        → {signed_in: false, email}                 otherwise: a code is on its way
//
// Invites are single use. Accepting one creates (or updates) a pending person;
// the invite stays usable until that person has finished signing in, so a
// mistyped email can be fixed by opening the link again. Typing the address of
// someone who already has an account just sends them a sign-in code and leaves
// the invite alone.

import { httpError } from '../lib/guards.js';
import { newId } from '../lib/ids.js';
import { now } from '../lib/time.js';
import { sha256 } from '../lib/tokens.js';
import { clientIp, readEmail, readName, sendSignInCode, signIn } from './auth.js';

const PROBLEMS = {
  unknown: [404, "We couldn't find that invite. Please check the link, or ask Ben for a new one."],
  revoked: [410, 'That invite was cancelled. Please ask Ben for a new one.'],
  expired: [410, 'That invite has expired. Please ask Ben for a new one.'],
  used: [410, 'That invite has already been used. If it was yours, sign in with your email instead.'],
};

const ACCOUNT_REMOVED = "That email's account has been turned off. Please ask Ben if that's a mistake.";

function findInvite(db, token) {
  if (typeof token !== 'string' || token.length < 20 || token.length > 200) return null;
  return db.prepare('SELECT * FROM invites WHERE token_hash = ?').get(sha256(token)) ?? null;
}

// Why the invite can't be used, or null when it can.
function inviteProblem(db, invite) {
  if (!invite) return 'unknown';
  if (invite.revoked_at) return 'revoked';
  if (invite.expires_at <= now()) return 'expired';
  if (invite.used_at) {
    const by = invite.used_by ? db.prepare('SELECT status FROM users WHERE id = ?').get(invite.used_by) : null;
    if (by?.status !== 'pending') return 'used';
  }
  return null;
}

// True when opening the link proves the address: the app itself mailed this
// invite to exactly that email.
function provesEmail(invite, email) {
  return Boolean(invite.sent_at && invite.email && invite.email.toLowerCase() === email.toLowerCase());
}

// Finds or makes the person this acceptance is for and marks the invite used
// by them. Someone who already has an account only uses it up when the link
// proves their address (so a stranger can't burn it by typing their email).
function claimInvite(db, invite, { name, email, proven }) {
  return db.transaction(() => {
    const at = now();
    const markUsed = (userId) =>
      db.prepare('UPDATE invites SET used_at = ?, used_by = ? WHERE id = ?').run(at, userId, invite.id);
    const existing = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
    if (existing?.status === 'removed') {
      throw httpError(403, 'account_removed', ACCOUNT_REMOVED);
    }
    if (existing?.status === 'active') {
      if (proven) markUsed(existing.id);
      return existing;
    }

    let user = existing;
    if (user) {
      db.prepare('UPDATE users SET name = ? WHERE id = ?').run(name, user.id);
    } else {
      // Opening the link again after a typo: fix the person it made last time.
      const earlier = invite.used_by
        ? db.prepare("SELECT * FROM users WHERE id = ? AND status = 'pending'").get(invite.used_by)
        : null;
      if (earlier) {
        db.prepare('UPDATE users SET name = ?, email = ? WHERE id = ?').run(name, email, earlier.id);
        user = earlier;
      } else {
        user = { id: newId() };
        db.prepare(
          `INSERT INTO users (id, name, email, role, status, color, created_at, activated_at, removed_at)
           VALUES (?, ?, ?, ?, 'pending', NULL, ?, NULL, NULL)`,
        ).run(user.id, name, email, invite.role, at);
      }
    }
    markUsed(user.id);
    return db.prepare('SELECT * FROM users WHERE id = ?').get(user.id);
  })();
}

export default async function inviteRoutes(app, { db }) {
  const perIp = (max, timeWindow) => ({ rateLimit: { max, timeWindow, keyGenerator: clientIp } });

  app.get('/api/invites/:token', { config: perIp(60, '1 minute') }, async (request, reply) => {
    reply.header('cache-control', 'no-store');
    const invite = findInvite(db, request.params.token);
    const reason = inviteProblem(db, invite);
    if (reason) return { valid: false, name: null, email: null, emailed: false, reason };
    return {
      valid: true,
      name: invite.name ?? null,
      email: invite.email ?? null,
      emailed: Boolean(invite.sent_at && invite.email),
      reason: null,
    };
  });

  app.post('/api/invites/:token/accept', { config: perIp(20, '1 hour') }, async (request, reply) => {
    const invite = findInvite(db, request.params.token);
    const problem = inviteProblem(db, invite);
    if (problem) throw httpError(PROBLEMS[problem][0], `invite_${problem}`, PROBLEMS[problem][1]);

    const body = request.body ?? {};
    const name = readName(body.name ?? invite.name);
    const email = readEmail(body.email ?? invite.email);
    const proven = provesEmail(invite, email);
    const user = claimInvite(db, invite, { name, email, proven });

    if (proven) {
      return { signed_in: true, ...signIn(request, reply, user) };
    }

    const { sent } = await sendSignInCode(app, user, { ip: clientIp(request) });
    if (!sent) {
      throw httpError(
        429,
        'rate_limited',
        "We've sent a lot of codes to that address in the last hour. Please use the newest one, or try again later.",
      );
    }
    reply.header('cache-control', 'no-store');
    return { signed_in: false, email: user.email };
  });
}
