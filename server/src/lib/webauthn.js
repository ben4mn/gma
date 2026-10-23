// Passkeys ("sign in the way you unlock your phone") on @simplewebauthn/server 14.
// The rules come from docs/research/passkeys-research.json:
//
// - Registration makes a discoverable credential (residentKey 'required') on
//   the phone itself, with user verification required and attestation 'none',
//   excluding the passkeys the person already has.
// - Login is usernameless: allowCredentials stays empty and the credential id
//   finds the person.
// - Challenges live on the server (webauthn_challenges): single use, 5 minutes,
//   tied to the browser that asked by a signed pre-auth cookie. The client never
//   tells us which challenge it answered.
// - Verification pins expectedOrigin to PUBLIC_URL's origin (not the address
//   behind the tunnel), expectedRPID to WEBAUTHN_RP_ID and requires UV.
// - Synced passkeys (Apple, Google) keep counter 0. That's normal, not cloning.
//
// Every failure a person can cause is one gentle sentence; the details go to
// the log, because Safari reports a cancel and a real failure the same way.

import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
} from '@simplewebauthn/server';
import { httpError } from './guards.js';
import { newId } from './ids.js';
import { MINUTE, now } from './time.js';
import { hmac, safeEqual } from './tokens.js';
import { immediate } from './tx.js';

export const CHALLENGE_COOKIE = 'gma_webauthn';
export const CHALLENGE_TTL_MS = 5 * MINUTE;
const CHALLENGE_COOKIE_PATH = '/api/auth/passkey';

export const PASSKEY_FAILED = "That didn't work. Try again or get an email code.";
const UNKNOWN_PASSKEY = "We don't recognise that passkey any more. Please get an email code instead.";

// Names people recognise for the common passkey providers (by AAGUID). The
// passkeys table has no aaguid column, so the name is kept as the label.
const PROVIDER_NAMES = new Map([
  ['fbfc3007-154e-4ecc-8c0b-6e020557d7bd', 'Apple Passwords'],
  ['dd4ec289-e01d-41c9-bb89-70fa845d4bf2', 'Apple Passwords'],
  ['ea9b8d66-4d01-1d21-3ce4-b6b48cb575d4', 'Google Password Manager'],
  ['adce0002-35bc-c60a-648b-0b25f1f05503', 'Chrome on Mac'],
  ['08987058-cadc-4b81-b6e1-30de50dcbe96', 'Windows Hello'],
  ['53414d53-554e-4700-0000-000000000000', 'Samsung Pass'],
  ['bada5566-a7aa-401f-bd96-45619a55120d', '1Password'],
  ['d548826e-79b4-db40-a3d8-11116f7e8349', 'Bitwarden'],
]);

export function providerName(aaguid) {
  return PROVIDER_NAMES.get(String(aaguid ?? '').toLowerCase()) ?? 'Passkey';
}

// The WebAuthn user handle: stable per person (so re-registering on the same
// phone replaces rather than duplicates), opaque, and free of personal data.
export function userHandleFor(config, userId) {
  return new Uint8Array(Buffer.from(hmac(config.secretKey, `webauthn-user:${userId}`), 'hex'));
}

export function userHandleB64(config, userId) {
  return Buffer.from(userHandleFor(config, userId)).toString('base64url');
}

function parseTransports(json) {
  try {
    const list = JSON.parse(json ?? '[]');
    return Array.isArray(list) ? list.filter((t) => typeof t === 'string') : [];
  } catch {
    return [];
  }
}

export function publicPasskey(row) {
  return {
    id: row.id,
    label: row.label ?? 'Passkey',
    backed_up: row.backed_up === 1,
    device_type: row.device_type ?? null,
    created_at: row.created_at,
    last_used_at: row.last_used_at ?? null,
  };
}

export function listPasskeys(db, userId) {
  return db
    .prepare('SELECT * FROM passkeys WHERE user_id = ? ORDER BY created_at DESC')
    .all(userId)
    .map(publicPasskey);
}

export function countPasskeys(db, userId) {
  return db.prepare('SELECT COUNT(*) AS n FROM passkeys WHERE user_id = ?').get(userId).n;
}

// Deletes one of the person's own passkeys. Returns false when it isn't theirs.
export function deletePasskey(db, userId, passkeyId) {
  return db.prepare('DELETE FROM passkeys WHERE id = ? AND user_id = ?').run(passkeyId, userId).changes === 1;
}

// ---- challenges -----------------------------------------------------------

function saveChallenge(db, { kind, userId = null, challenge }) {
  const at = now();
  const id = newId();
  immediate(db, () => {
    db.prepare('DELETE FROM webauthn_challenges WHERE expires_at <= ?').run(at);
    db.prepare(
      'INSERT INTO webauthn_challenges (id, user_id, challenge, kind, expires_at) VALUES (?, ?, ?, ?, ?)',
    ).run(id, userId, challenge, kind, at + CHALLENGE_TTL_MS);
  });
  return id;
}

// Single use: the row is deleted whether or not the answer turns out good.
function takeChallenge(db, challengeId, kind) {
  if (!challengeId) return null;
  const row = db.prepare('DELETE FROM webauthn_challenges WHERE id = ? RETURNING *').get(challengeId);
  if (!row || row.kind !== kind || row.expires_at <= now()) return null;
  return row;
}

function challengeSignature(config, challengeId) {
  return hmac(config.secretKey, `webauthn-challenge:${challengeId}`).slice(0, 32);
}

export function setChallengeCookie(reply, config, challengeId) {
  reply.setCookie(CHALLENGE_COOKIE, `${challengeId}.${challengeSignature(config, challengeId)}`, {
    httpOnly: true,
    secure: config.cookieSecure,
    sameSite: 'strict',
    path: CHALLENGE_COOKIE_PATH,
    maxAge: CHALLENGE_TTL_MS / 1000,
  });
}

// Reads the challenge id from the pre-auth cookie (and clears the cookie, since
// the challenge is single use). Returns null for a missing or forged cookie.
export function takeChallengeCookie(request, reply, config) {
  const raw = request.cookies?.[CHALLENGE_COOKIE];
  reply.clearCookie(CHALLENGE_COOKIE, { path: CHALLENGE_COOKIE_PATH });
  if (typeof raw !== 'string' || raw.length > 100) return null;
  const [id, signature] = raw.split('.');
  if (!id || !signature || !safeEqual(signature, challengeSignature(config, id))) return null;
  return id;
}

// ---- registration ---------------------------------------------------------

export async function createRegistrationOptions(db, config, user) {
  const existing = db.prepare('SELECT id, transports FROM passkeys WHERE user_id = ?').all(user.id);
  const options = await generateRegistrationOptions({
    rpName: config.webauthnRpName,
    rpID: config.webauthnRpId,
    userName: user.email,
    userDisplayName: user.name,
    userID: userHandleFor(config, user.id),
    timeout: CHALLENGE_TTL_MS,
    attestationType: 'none',
    excludeCredentials: existing.map((p) => ({ id: p.id, transports: parseTransports(p.transports) })),
    authenticatorSelection: { residentKey: 'required', userVerification: 'required' },
    // The phone's own keychain, so nobody lands on the "use a security key" sheet.
    preferredAuthenticatorType: 'localDevice',
  });
  const challengeId = saveChallenge(db, { kind: 'register', userId: user.id, challenge: options.challenge });
  return { options, challengeId };
}

function isCredentialJson(response) {
  return (
    response !== null &&
    typeof response === 'object' &&
    typeof response.id === 'string' &&
    response.id.length > 0 &&
    response.id.length <= 1024 &&
    typeof response.response === 'object' &&
    response.response !== null
  );
}

// Checks the phone's answer and stores the new passkey. Returns the stored row.
export async function verifyRegistration(db, config, { challengeId, user, response, log }) {
  const challenge = takeChallenge(db, challengeId, 'register');
  if (!challenge || challenge.user_id !== user.id) {
    log?.info({ userId: user.id }, 'Passkey registration without a live challenge');
    throw httpError(400, 'passkey_failed', PASSKEY_FAILED);
  }
  if (!isCredentialJson(response)) throw httpError(400, 'passkey_failed', PASSKEY_FAILED);

  let verification;
  try {
    verification = await verifyRegistrationResponse({
      response,
      expectedChallenge: challenge.challenge,
      expectedOrigin: config.publicOrigin,
      expectedRPID: config.webauthnRpId,
      requireUserVerification: true,
    });
  } catch (err) {
    log?.info({ userId: user.id, reason: err.message }, 'Passkey registration was rejected');
    throw httpError(400, 'passkey_failed', PASSKEY_FAILED);
  }
  if (!verification.verified) throw httpError(400, 'passkey_failed', PASSKEY_FAILED);

  const info = verification.registrationInfo;
  const { credential } = info;
  const owner = db.prepare('SELECT user_id FROM passkeys WHERE id = ?').get(credential.id);
  if (owner && owner.user_id !== user.id) {
    log?.warn({ userId: user.id }, 'Passkey registration reused a credential id from another person');
    throw httpError(409, 'passkey_failed', PASSKEY_FAILED);
  }

  const row = {
    id: credential.id,
    user_id: user.id,
    public_key: Buffer.from(credential.publicKey),
    counter: credential.counter,
    transports: JSON.stringify(credential.transports ?? response.response.transports ?? []),
    device_type: info.credentialDeviceType,
    backed_up: info.credentialBackedUp ? 1 : 0,
    label: providerName(info.aaguid),
    created_at: now(),
    last_used_at: null,
  };
  db.prepare(
    `INSERT INTO passkeys (id, user_id, public_key, counter, transports, device_type, backed_up, label,
                           created_at, last_used_at)
     VALUES (@id, @user_id, @public_key, @counter, @transports, @device_type, @backed_up, @label,
             @created_at, @last_used_at)
     ON CONFLICT (id) DO UPDATE SET public_key = excluded.public_key, counter = excluded.counter,
       transports = excluded.transports, device_type = excluded.device_type, backed_up = excluded.backed_up`,
  ).run(row);
  return db.prepare('SELECT * FROM passkeys WHERE id = ?').get(credential.id);
}

// ---- login ----------------------------------------------------------------

export async function createLoginOptions(db, config) {
  const options = await generateAuthenticationOptions({
    rpID: config.webauthnRpId,
    allowCredentials: [],
    userVerification: 'required',
    timeout: CHALLENGE_TTL_MS,
  });
  const challengeId = saveChallenge(db, { kind: 'login', challenge: options.challenge });
  return { options, challengeId };
}

// Checks a usernameless sign-in. Returns { user, passkey } for an active or
// pending person. An unknown credential (deleted, made elsewhere, or its owner
// removed) is a 404 'unknown_credential' so the client can switch to a code.
export async function verifyLogin(db, config, { challengeId, response, log }) {
  const challenge = takeChallenge(db, challengeId, 'login');
  if (!challenge) {
    log?.info('Passkey sign-in without a live challenge');
    throw httpError(400, 'passkey_failed', PASSKEY_FAILED);
  }
  if (!isCredentialJson(response)) throw httpError(400, 'passkey_failed', PASSKEY_FAILED);

  const passkey = db.prepare('SELECT * FROM passkeys WHERE id = ?').get(response.id);
  const user = passkey ? db.prepare('SELECT * FROM users WHERE id = ?').get(passkey.user_id) : null;
  if (!passkey || !user || user.status === 'removed') {
    throw httpError(404, 'unknown_credential', UNKNOWN_PASSKEY);
  }

  // The phone also says whose passkey it is; it must agree with our records.
  const handle = response.response.userHandle;
  if (handle !== undefined && handle !== null && !safeEqual(String(handle), userHandleB64(config, user.id))) {
    log?.warn({ userId: user.id }, 'Passkey sign-in with a mismatched user handle');
    throw httpError(400, 'passkey_failed', PASSKEY_FAILED);
  }

  let verification;
  try {
    verification = await verifyAuthenticationResponse({
      response,
      expectedChallenge: challenge.challenge,
      expectedOrigin: config.publicOrigin,
      expectedRPID: config.webauthnRpId,
      credential: {
        id: passkey.id,
        publicKey: new Uint8Array(passkey.public_key),
        counter: passkey.counter,
        transports: parseTransports(passkey.transports),
      },
      requireUserVerification: true,
    });
  } catch (err) {
    log?.info({ userId: user.id, reason: err.message }, 'Passkey sign-in was rejected');
    throw httpError(400, 'passkey_failed', PASSKEY_FAILED);
  }
  if (!verification.verified) throw httpError(400, 'passkey_failed', PASSKEY_FAILED);

  const info = verification.authenticationInfo;
  db.prepare(
    'UPDATE passkeys SET counter = ?, backed_up = ?, device_type = ?, last_used_at = ? WHERE id = ?',
  ).run(info.newCounter, info.credentialBackedUp ? 1 : 0, info.credentialDeviceType, now(), passkey.id);
  return { user, passkey: db.prepare('SELECT * FROM passkeys WHERE id = ?').get(passkey.id) };
}
