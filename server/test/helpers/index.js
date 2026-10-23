// Shared test helpers. Every app gets its own temp DATA_DIR and MEDIA_DIR,
// the console email transport (captured, never printed) and NODE_ENV=test.
//
//   const t = await makeTestApp();
//   const user = makeUser(t.db, { role: 'admin' });
//   const cookie = loginAs(t.app, t.db, user);
//   const res = await t.app.inject({ method: 'GET', url: '/api/me', headers: { cookie } });
//   await t.cleanup();

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { buildApp } from '../../src/app.js';
import { loadConfig } from '../../src/config.js';
import { captureEmails } from '../../src/lib/email.js';
import { newId } from '../../src/lib/ids.js';
import { createSession, SESSION_COOKIE } from '../../src/lib/sessions.js';
import { randomToken, sha256 } from '../../src/lib/tokens.js';

export const TEST_ORIGIN = 'http://localhost:8080';

export async function makeTempDir(prefix = 'gma-test-') {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

// The config tests use: temp dirs plus any env overrides.
export function makeTestConfig(tempDir, env = {}) {
  return loadConfig({
    NODE_ENV: 'test',
    PUBLIC_URL: TEST_ORIGIN,
    DATA_DIR: path.join(tempDir, 'data'),
    MEDIA_DIR: path.join(tempDir, 'media'),
    EMAIL_TRANSPORT: 'console',
    LOG_LEVEL: 'silent',
    ...env,
  });
}

// Options: `env` (config overrides, e.g. { WEB_DIR }), `routeOptions`, `plugins`.
export async function makeTestApp({ env = {}, routeOptions = {}, plugins = [] } = {}) {
  const tempDir = await makeTempDir();
  const config = makeTestConfig(tempDir, env);
  const mail = captureEmails(config);
  let app;
  try {
    app = await buildApp(config, { routeOptions, plugins });
  } catch (err) {
    await fs.rm(tempDir, { recursive: true, force: true });
    throw err;
  }
  return {
    app,
    db: app.db,
    config,
    mail,
    tempDir,
    async cleanup() {
      await app.close();
      await fs.rm(tempDir, { recursive: true, force: true });
    },
  };
}

let userCounter = 0;

export function makeUser(db, overrides = {}) {
  userCounter += 1;
  const now = Date.now();
  const user = {
    id: newId(),
    name: `Person ${userCounter}`,
    email: `person${userCounter}-${Math.random().toString(36).slice(2, 8)}@example.com`,
    role: 'member',
    status: 'active',
    color: null,
    created_at: now,
    activated_at: now,
    removed_at: null,
    ...overrides,
  };
  db.prepare(
    `INSERT INTO users (id, name, email, role, status, color, created_at, activated_at, removed_at)
     VALUES (@id, @name, @email, @role, @status, @color, @created_at, @activated_at, @removed_at)`,
  ).run(user);
  return user;
}

// Returns the device row plus `token`, the pairing token (only its hash is stored).
export function makeDevice(db, overrides = {}) {
  const token = randomToken(32);
  const device = {
    id: newId(),
    name: "Grandma's frame",
    token_hash: sha256(token),
    created_by: null,
    created_at: Date.now(),
    last_seen_at: null,
    revoked_at: null,
    ...overrides,
  };
  db.prepare(
    `INSERT INTO devices (id, name, token_hash, created_by, created_at, last_seen_at, revoked_at)
     VALUES (@id, @name, @token_hash, @created_by, @created_at, @last_seen_at, @revoked_at)`,
  ).run(device);
  return { ...device, token };
}

// A cookie header value for a fresh session: `headers: { cookie: loginAs(app, db, user) }`.
export function loginAs(app, db, user) {
  const { token } = createSession(db, { kind: 'user', userId: user.id, userAgent: 'node-test' });
  return `${SESSION_COOKIE}=${token}`;
}

export function loginAsDevice(app, db, device) {
  const { token } = createSession(db, { kind: 'device', deviceId: device.id, userAgent: 'node-test' });
  return `${SESSION_COOKIE}=${token}`;
}

// Headers for a state-changing request as the real app would send them.
export function sameOrigin(cookie, extra = {}) {
  return { origin: TEST_ORIGIN, ...(cookie ? { cookie } : {}), ...extra };
}

// A throwaway web/ folder for page tests: the family shell, the frame shell,
// an asset and a module, each with recognisable contents.
export async function makeWebFixture(tempDir) {
  const webDir = path.join(tempDir, 'web');
  await fs.mkdir(path.join(webDir, 'grandma'), { recursive: true });
  await fs.mkdir(path.join(webDir, 'assets'), { recursive: true });
  await fs.mkdir(path.join(webDir, 'app'), { recursive: true });
  await fs.writeFile(path.join(webDir, 'index.html'), '<!doctype html><title>family shell</title>');
  await fs.writeFile(path.join(webDir, 'grandma', 'index.html'), '<!doctype html><title>frame shell</title>');
  await fs.writeFile(path.join(webDir, 'assets', 'mark.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>');
  await fs.writeFile(path.join(webDir, 'app', 'main.js'), 'export const ok = true;\n');
  await fs.writeFile(path.join(webDir, '.secret'), 'nope');
  return webDir;
}
