// ULIDs: 26 Crockford base32 characters, 48 bits of time then 80 random bits.
// They sort by creation time, which makes them good pagination cursors.
// Ids made in the same millisecond by this process stay in order (monotonic).

import { randomBytes } from 'node:crypto';

const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const ID_PATTERN = /^[0-9A-HJKMNP-TV-Z]{26}$/;

let lastTime = -1;
let lastRandom = null; // 16 base32 digits (values 0..31)

function encodeTime(ms) {
  let out = '';
  for (let i = 0; i < 10; i++) {
    out = ALPHABET[ms % 32] + out;
    ms = Math.floor(ms / 32);
  }
  return out;
}

function freshRandom() {
  const bytes = randomBytes(16);
  return Array.from(bytes, (b) => b & 31);
}

function increment(digits) {
  const next = digits.slice();
  for (let i = next.length - 1; i >= 0; i--) {
    if (next[i] < 31) {
      next[i] += 1;
      return next;
    }
    next[i] = 0;
  }
  return freshRandom(); // overflow after 2^80 ids in one millisecond: not a real concern
}

export function newId(now = Date.now()) {
  if (now === lastTime && lastRandom) {
    lastRandom = increment(lastRandom);
  } else {
    lastTime = now;
    lastRandom = freshRandom();
  }
  return encodeTime(now) + lastRandom.map((d) => ALPHABET[d]).join('');
}

export function isId(value) {
  return typeof value === 'string' && ID_PATTERN.test(value);
}

// The creation time (ms) encoded in a ULID.
export function idTime(id) {
  if (!isId(id)) throw new TypeError('Not a ULID');
  let ms = 0;
  for (const ch of id.slice(0, 10)) ms = ms * 32 + ALPHABET.indexOf(ch);
  return ms;
}
