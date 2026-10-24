// Random tokens, hashes and constant-time comparison.
// Tokens (sessions, invites, devices, confirm links) are stored only as their
// SHA-256; short secrets that could be brute-forced (6-digit codes) are stored
// as an HMAC keyed with SECRET_KEY.

import { createHash, createHmac, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';

export function randomToken(bytes = 32) {
  return randomBytes(bytes).toString('base64url');
}

// A string of `length` decimal digits, uniformly random (keeps leading zeros).
export function randomDigits(length = 6) {
  let out = '';
  for (let i = 0; i < length; i++) out += String(randomInt(10));
  return out;
}

export function sha256(value) {
  return createHash('sha256').update(String(value)).digest('hex');
}

export function hmac(secretKey, value) {
  return createHmac('sha256', secretKey).update(String(value)).digest('hex');
}

// Compares two strings without leaking where they differ. Unequal lengths are
// compared through their hashes so the length isn't leaked either.
export function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const left = Buffer.from(sha256(a), 'hex');
  const right = Buffer.from(sha256(b), 'hex');
  return timingSafeEqual(left, right) && a.length === b.length;
}
