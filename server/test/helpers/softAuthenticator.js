// A software passkey authenticator for tests: an ES256 key pair per credential,
// 'none' attestation, discoverable credentials, and the UV flag set the way a
// phone sets it after Face ID. It answers the options JSON our routes return
// with the same JSON @simplewebauthn/browser would post back.
//
//   const phone = createSoftAuthenticator({ origin: TEST_ORIGIN });
//   const registration = phone.register(creationOptionsJSON);
//   const assertion = phone.login(requestOptionsJSON);
//
// Options: `origin` (what goes in clientDataJSON), `userVerified` (false to
// leave the UV flag off), `backedUp` (synced passkey flags), `aaguid`,
// `counterStep` (0 like Apple and Google; >0 like a security key). They stay
// changeable afterwards through `phone.settings`.

import { createHash, generateKeyPairSync, randomBytes, sign } from 'node:crypto';

export const APPLE_AAGUID = 'fbfc3007-154e-4ecc-8c0b-6e020557d7bd';

const FLAG_UP = 0x01;
const FLAG_UV = 0x04;
const FLAG_BE = 0x08;
const FLAG_BS = 0x10;
const FLAG_AT = 0x40;

// ---- the smallest CBOR encoder that covers attestation objects and COSE keys

function cborHead(major, length) {
  if (length < 24) return Buffer.from([(major << 5) | length]);
  if (length < 0x100) return Buffer.from([(major << 5) | 24, length]);
  if (length < 0x10000) return Buffer.from([(major << 5) | 25, length >> 8, length & 0xff]);
  const out = Buffer.alloc(5);
  out[0] = (major << 5) | 26;
  out.writeUInt32BE(length, 1);
  return out;
}

export function cbor(value) {
  if (Number.isInteger(value)) return value >= 0 ? cborHead(0, value) : cborHead(1, -1 - value);
  if (typeof value === 'string') {
    const bytes = Buffer.from(value, 'utf8');
    return Buffer.concat([cborHead(3, bytes.length), bytes]);
  }
  if (value instanceof Uint8Array) return Buffer.concat([cborHead(2, value.length), Buffer.from(value)]);
  if (value instanceof Map) {
    const parts = [cborHead(5, value.size)];
    for (const [k, v] of value) parts.push(cbor(k), cbor(v));
    return Buffer.concat(parts);
  }
  throw new TypeError(`cbor: unsupported value ${typeof value}`);
}

// ---- helpers

const sha256 = (data) => createHash('sha256').update(data).digest();
const b64url = (buf) => Buffer.from(buf).toString('base64url');

function uuidBytes(uuid) {
  return Buffer.from(uuid.replace(/-/g, ''), 'hex');
}

function coseKey(publicKey) {
  const jwk = publicKey.export({ format: 'jwk' });
  return cbor(
    new Map([
      [1, 2], // kty: EC2
      [3, -7], // alg: ES256
      [-1, 1], // crv: P-256
      [-2, Buffer.from(jwk.x, 'base64url')],
      [-3, Buffer.from(jwk.y, 'base64url')],
    ]),
  );
}

function clientData(type, challenge, origin) {
  return Buffer.from(JSON.stringify({ type, challenge, origin, crossOrigin: false }), 'utf8');
}

export function createSoftAuthenticator({
  origin,
  userVerified = true,
  backedUp = true,
  aaguid = APPLE_AAGUID,
  counterStep = 0,
} = {}) {
  if (!origin) throw new TypeError('createSoftAuthenticator needs the origin');
  const settings = { origin, userVerified, backedUp, aaguid, counterStep };
  const credentials = []; // { id, rpId, userHandle, privateKey, publicKey, counter }

  function flags({ attested }) {
    let f = FLAG_UP;
    if (settings.userVerified) f |= FLAG_UV;
    if (settings.backedUp) f |= FLAG_BE | FLAG_BS;
    if (attested) f |= FLAG_AT;
    return f;
  }

  function authData(rpId, flagByte, counter, attestedData = Buffer.alloc(0)) {
    const counterBytes = Buffer.alloc(4);
    counterBytes.writeUInt32BE(counter);
    return Buffer.concat([sha256(rpId), Buffer.from([flagByte]), counterBytes, attestedData]);
  }

  return {
    settings,
    credentials,

    // navigator.credentials.create() with these creation options.
    register(options) {
      const rpId = options.rp.id;
      const excluded = new Set((options.excludeCredentials ?? []).map((c) => c.id));
      if (credentials.some((c) => c.rpId === rpId && excluded.has(c.id))) {
        throw Object.assign(new Error('This authenticator already has a passkey for that account'), {
          name: 'InvalidStateError',
        });
      }
      const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
      const rawId = randomBytes(16);
      const credential = {
        id: b64url(rawId),
        rpId,
        userHandle: options.user.id,
        privateKey,
        publicKey,
        counter: 0,
      };
      // Same account on the same authenticator: the new passkey replaces the old one.
      const replaced = credentials.findIndex((c) => c.rpId === rpId && c.userHandle === credential.userHandle);
      if (replaced !== -1) credentials.splice(replaced, 1);
      credentials.push(credential);

      const idLength = Buffer.alloc(2);
      idLength.writeUInt16BE(rawId.length);
      const attested = Buffer.concat([uuidBytes(settings.aaguid), idLength, rawId, coseKey(publicKey)]);
      const attestationObject = cbor(
        new Map([
          ['fmt', 'none'],
          ['attStmt', new Map()],
          ['authData', authData(rpId, flags({ attested: true }), 0, attested)],
        ]),
      );
      return {
        id: credential.id,
        rawId: credential.id,
        type: 'public-key',
        response: {
          clientDataJSON: b64url(clientData('webauthn.create', options.challenge, settings.origin)),
          attestationObject: b64url(attestationObject),
          transports: ['internal', 'hybrid'],
        },
        clientExtensionResults: {},
        authenticatorAttachment: 'platform',
      };
    },

    // navigator.credentials.get() with these request options (usernameless when
    // allowCredentials is empty). `credentialId` picks one when there are several.
    login(options, { credentialId } = {}) {
      const rpId = options.rpId;
      const allowed = new Set((options.allowCredentials ?? []).map((c) => c.id));
      const candidates = credentials.filter(
        (c) => c.rpId === rpId && (allowed.size === 0 || allowed.has(c.id)) && (!credentialId || c.id === credentialId),
      );
      const credential = candidates.at(-1);
      if (!credential) throw Object.assign(new Error('No passkey for this site'), { name: 'NotAllowedError' });

      credential.counter += settings.counterStep;
      const data = authData(rpId, flags({ attested: false }), credential.counter);
      const clientDataJSON = clientData('webauthn.get', options.challenge, settings.origin);
      const signature = sign('sha256', Buffer.concat([data, sha256(clientDataJSON)]), credential.privateKey);
      return {
        id: credential.id,
        rawId: credential.id,
        type: 'public-key',
        response: {
          clientDataJSON: b64url(clientDataJSON),
          authenticatorData: b64url(data),
          signature: b64url(signature),
          userHandle: credential.userHandle,
        },
        clientExtensionResults: {},
        authenticatorAttachment: 'platform',
      };
    },
  };
}
