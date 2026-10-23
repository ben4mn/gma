// loadConfig(env) turns environment variables into one frozen config object.
// Every key in docs/ARCHITECTURE.md#configuration becomes a camelCase property
// (PUBLIC_URL → publicUrl, MAX_UPLOAD_BYTES → maxUploadBytes, …), plus a few
// derived values (publicOrigin, dbPath, cookieSecure, isProduction).

import { isIP } from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url));

// Only used when NODE_ENV is development or test, never in production.
const DEV_SECRET_KEY = 'ZGV2LW9ubHktc2VjcmV0LWtleS1mb3ItZ21hLW5ldmVyLXVzZS1pbi1wcm9kdWN0aW9u';

export class ConfigError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ConfigError';
  }
}

function str(env, key, fallback) {
  const value = env[key];
  return value === undefined || value === '' ? fallback : String(value).trim();
}

function int(env, key, fallback) {
  const raw = str(env, key, undefined);
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new ConfigError(`${key} must be a whole number, got "${raw}".`);
  }
  return value;
}

// TRUST_PROXY: true (trust whoever connects; only safe when nothing but the
// proxy can reach the app), false, or a comma-separated list of the proxies'
// addresses and CIDR ranges ("10.35.0.3", "10.35.0.0/24, fd00::/8"). A list
// is passed to Fastify as an array, so `request.ip` only follows
// X-Forwarded-For from those peers, and lib/client-ip.js only believes their
// CF-Connecting-IP.
export function parseTrustProxy(raw, fallback) {
  if (raw === undefined || raw === null || String(raw).trim() === '') return fallback;
  const value = String(raw).trim();
  if (/^(1|true|yes|on)$/i.test(value)) return true;
  if (/^(0|false|no|off)$/i.test(value)) return false;
  const entries = value.split(',').map((entry) => entry.trim()).filter(Boolean);
  for (const entry of entries) {
    const [address, prefix, extra] = entry.split('/');
    const family = isIP(address);
    const maxPrefix = family === 6 ? 128 : 32;
    const prefixOk = prefix === undefined || (/^\d{1,3}$/.test(prefix) && Number(prefix) <= maxPrefix);
    if (family === 0 || !prefixOk || extra !== undefined) {
      throw new ConfigError(
        `TRUST_PROXY must be true, false or a comma-separated list of IP addresses or ranges (like 10.35.0.3 or 10.35.0.0/24), got "${value}".`,
      );
    }
  }
  return Object.freeze(entries);
}

// MEDIA_SENTINEL: a file that must exist in MEDIA_DIR before the app or the
// worker starts, so an unmounted drive never means photos written to the
// wrong disk. On by default in production; "off" turns it off.
function mediaSentinel(env, isProduction) {
  const raw = str(env, 'MEDIA_SENTINEL', isProduction ? '.gma-media' : '');
  if (raw === '' || /^(off|none|false|0)$/i.test(raw)) return '';
  if (!/^[A-Za-z0-9._-]+$/.test(raw) || raw === '.' || raw === '..') {
    throw new ConfigError(`MEDIA_SENTINEL must be a plain file name like .gma-media, got "${raw}".`);
  }
  return raw;
}

function parseUrl(key, raw) {
  try {
    const url = new URL(raw);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error('not http(s)');
    return url;
  } catch {
    throw new ConfigError(`${key} must be a full http(s) URL, got "${raw}".`);
  }
}

export function loadConfig(env = process.env) {
  const nodeEnv = str(env, 'NODE_ENV', 'production');
  if (!['production', 'development', 'test'].includes(nodeEnv)) {
    throw new ConfigError(`NODE_ENV must be production, development or test, got "${nodeEnv}".`);
  }
  const isProduction = nodeEnv === 'production';
  const host = str(env, 'HOST', '0.0.0.0');
  const port = int(env, 'PORT', 8080);

  const rawPublicUrl = str(env, 'PUBLIC_URL', isProduction ? undefined : `http://localhost:${port}`);
  if (!rawPublicUrl) throw new ConfigError('PUBLIC_URL is required in production (for example https://gma.4mn.org).');
  const publicUrlObj = parseUrl('PUBLIC_URL', rawPublicUrl);
  const publicOrigin = publicUrlObj.origin;

  const secretKey = str(env, 'SECRET_KEY', isProduction ? undefined : DEV_SECRET_KEY);
  if (!secretKey) throw new ConfigError('SECRET_KEY is required in production (openssl rand -base64 48).');
  if (Buffer.from(secretKey, 'base64').length < 32) {
    throw new ConfigError('SECRET_KEY must be at least 32 random bytes, base64-encoded (openssl rand -base64 48).');
  }

  const dataDir = path.resolve(str(env, 'DATA_DIR', isProduction ? '/data' : path.join(REPO_ROOT, 'data')));
  const mediaDir = path.resolve(str(env, 'MEDIA_DIR', isProduction ? '/media' : path.join(REPO_ROOT, 'media')));

  const emailTransport = str(env, 'EMAIL_TRANSPORT', 'console');
  if (!['console', 'resend'].includes(emailTransport)) {
    throw new ConfigError(`EMAIL_TRANSPORT must be console or resend, got "${emailTransport}".`);
  }
  const resendApiKey = str(env, 'RESEND_API_KEY', '');
  if (emailTransport === 'resend' && !resendApiKey) {
    throw new ConfigError('RESEND_API_KEY is required when EMAIL_TRANSPORT=resend.');
  }

  const config = {
    nodeEnv,
    isProduction,
    publicUrl: publicOrigin + publicUrlObj.pathname.replace(/\/+$/, ''),
    publicOrigin,
    host,
    port,
    dataDir,
    mediaDir,
    mediaSentinel: mediaSentinel(env, isProduction),
    dbPath: path.join(dataDir, 'gma.sqlite'),
    webDir: path.resolve(str(env, 'WEB_DIR', path.join(REPO_ROOT, 'web'))),
    secretKey,
    emailTransport,
    resendApiKey,
    emailFrom: str(env, 'EMAIL_FROM', "Grandma's family <hello@auth.4mn.org>"),
    vapidPublicKey: str(env, 'VAPID_PUBLIC_KEY', ''),
    vapidPrivateKey: str(env, 'VAPID_PRIVATE_KEY', ''),
    vapidSubject: str(env, 'VAPID_SUBJECT', ''),
    webauthnRpId: str(env, 'WEBAUTHN_RP_ID', publicUrlObj.hostname),
    webauthnRpName: str(env, 'WEBAUTHN_RP_NAME', "Grandma's family"),
    maxUploadBytes: int(env, 'MAX_UPLOAD_BYTES', 2 * 1024 * 1024 * 1024),
    maxVideoSeconds: int(env, 'MAX_VIDEO_SECONDS', 180),
    maxVoiceSeconds: int(env, 'MAX_VOICE_SECONDS', 60),
    trustProxy: parseTrustProxy(env.TRUST_PROXY, isProduction),
    logLevel: str(env, 'LOG_LEVEL', nodeEnv === 'test' ? 'silent' : 'info'),
    // Secure cookies everywhere except plain-http development (http://localhost).
    cookieSecure: isProduction || publicUrlObj.protocol === 'https:',
  };
  return Object.freeze(config);
}
