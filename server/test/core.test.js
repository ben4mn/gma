// Core: config, the database and migrations, and the shared lib modules.

import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { ConfigError, loadConfig } from '../src/config.js';
import { listMigrations, migrate, openDb } from '../src/db/index.js';
import { captureEmails, EmailError, inviteEmail, sendEmail, signInCodeEmail } from '../src/lib/email.js';
import { audienceMatches, createEventHub, eventsAfter, publish, pruneEvents } from '../src/lib/events.js';
import { idTime, isId, newId } from '../src/lib/ids.js';
import { redactUrl, stripSecretParams } from '../src/lib/redact.js';
import {
  createSession,
  destroySession,
  loadSession,
  revokeDeviceSessions,
  revokeUserSessions,
  SESSION_MAX_AGE_SECONDS,
} from '../src/lib/sessions.js';
import { getSetting, getSettings, setSetting, setSettings } from '../src/lib/settings.js';
import { createStorage, safeJoin, UnsafePathError } from '../src/lib/storage.js';
import { clockInZone, inWindow, isNight } from '../src/lib/time.js';
import { hmac, randomDigits, randomToken, safeEqual, sha256 } from '../src/lib/tokens.js';
import { makeDevice, makeTempDir, makeTestConfig, makeUser } from './helpers/index.js';

const STRONG_SECRET = Buffer.alloc(48, 7).toString('base64');

describe('config', () => {
  test('test and development get working defaults', () => {
    const config = loadConfig({ NODE_ENV: 'test' });
    assert.equal(config.nodeEnv, 'test');
    assert.equal(config.isProduction, false);
    assert.equal(config.publicUrl, 'http://localhost:8080');
    assert.equal(config.publicOrigin, 'http://localhost:8080');
    assert.equal(config.cookieSecure, false);
    assert.equal(config.emailTransport, 'console');
    assert.equal(config.logLevel, 'silent');
    assert.equal(config.maxUploadBytes, 2147483648);
    assert.equal(config.maxVideoSeconds, 180);
    assert.equal(config.maxVoiceSeconds, 60);
    assert.equal(config.webauthnRpId, 'localhost');
    assert.ok(config.secretKey.length > 40);
    assert.ok(config.dbPath.endsWith(path.join('data', 'gma.sqlite')));
    assert.ok(Object.isFrozen(config));
  });

  test('production needs SECRET_KEY and PUBLIC_URL', () => {
    assert.throws(() => loadConfig({ NODE_ENV: 'production', PUBLIC_URL: 'https://gma.4mn.org' }), /SECRET_KEY/);
    assert.throws(() => loadConfig({ NODE_ENV: 'production', SECRET_KEY: STRONG_SECRET }), /PUBLIC_URL/);
    assert.throws(() => loadConfig({ SECRET_KEY: STRONG_SECRET }), ConfigError, 'NODE_ENV defaults to production');
  });

  test('production reads every key', () => {
    const config = loadConfig({
      NODE_ENV: 'production',
      PUBLIC_URL: 'https://gma.4mn.org/',
      SECRET_KEY: STRONG_SECRET,
      EMAIL_TRANSPORT: 'resend',
      RESEND_API_KEY: 're_123',
      PORT: '9000',
      MAX_VIDEO_SECONDS: '120',
      TRUST_PROXY: 'true',
    });
    assert.equal(config.publicUrl, 'https://gma.4mn.org');
    assert.equal(config.webauthnRpId, 'gma.4mn.org');
    assert.equal(config.webauthnRpName, "Grandma's family");
    assert.equal(config.cookieSecure, true);
    assert.equal(config.port, 9000);
    assert.equal(config.maxVideoSeconds, 120);
    assert.equal(config.trustProxy, true);
    assert.equal(config.dataDir, '/data');
    assert.equal(config.mediaDir, '/media');
    assert.equal(config.logLevel, 'info');
  });

  test('bad values fail with a readable message', () => {
    const base = { NODE_ENV: 'production', PUBLIC_URL: 'https://gma.4mn.org' };
    assert.throws(() => loadConfig({ ...base, SECRET_KEY: 'short' }), /at least 32 random bytes/);
    assert.throws(() => loadConfig({ NODE_ENV: 'test', PUBLIC_URL: 'gma.4mn.org' }), /full http\(s\) URL/);
    assert.throws(() => loadConfig({ NODE_ENV: 'test', PORT: 'eighty' }), /PORT must be a whole number/);
    assert.throws(() => loadConfig({ NODE_ENV: 'test', TRUST_PROXY: 'maybe' }), /TRUST_PROXY/);
    assert.throws(() => loadConfig({ NODE_ENV: 'test', EMAIL_TRANSPORT: 'smtp' }), /EMAIL_TRANSPORT/);
    assert.throws(() => loadConfig({ NODE_ENV: 'test', EMAIL_TRANSPORT: 'resend' }), /RESEND_API_KEY/);
    assert.throws(() => loadConfig({ NODE_ENV: 'staging' }), /NODE_ENV/);
  });
});

describe('database', () => {
  let dir;
  before(async () => {
    dir = await makeTempDir();
  });
  after(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  test('openDb sets the pragmas and applies 001_init once', () => {
    const file = path.join(dir, 'a', 'gma.sqlite');
    const db = openDb(file);
    assert.equal(db.pragma('journal_mode', { simple: true }), 'wal');
    assert.equal(db.pragma('foreign_keys', { simple: true }), 1);
    assert.equal(db.pragma('busy_timeout', { simple: true }), 5000);
    const applied = db.prepare('SELECT name FROM schema_migrations').all().map((r) => r.name);
    assert.deepEqual(applied, ['001_init.sql']);
    assert.deepEqual(migrate(db), [], 'a second run applies nothing');
    db.close();

    const reopened = openDb(file);
    assert.equal(reopened.prepare('SELECT COUNT(*) AS n FROM schema_migrations').get().n, 1);
    reopened.close();
  });

  test('the schema has every table in the contract, with the seed rows', () => {
    const db = openDb(path.join(dir, 'b.sqlite'));
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
      .all()
      .map((r) => r.name);
    for (const name of [
      'users', 'invites', 'login_codes', 'sessions', 'passkeys', 'webauthn_challenges', 'devices', 'items',
      'renditions', 'voice_notes', 'grandma_events', 'item_views', 'presets', 'push_subscriptions', 'jobs',
      'events', 'settings', 'admin_log', 'schema_migrations',
    ]) {
      assert.ok(tables.includes(name), `missing table ${name}`);
    }
    const presets = db.prepare('SELECT text FROM presets WHERE active = 1 ORDER BY sort').all().map((r) => r.text);
    assert.deepEqual(presets, [
      'Love you', 'Call me', 'Thank you', 'Miss you all', 'So beautiful', 'Made my day', 'Come visit soon', 'Proud of you',
    ]);
    for (const { id } of db.prepare('SELECT id FROM presets').all()) assert.ok(isId(id));
    assert.equal(getSetting(db, 'night_start'), '21:00');
    assert.equal(getSetting(db, 'night_end'), '07:00');
    assert.equal(getSetting(db, 'timezone'), 'America/Chicago');
    db.close();
  });

  test('constraints hold: unique emails ignore case, enums are checked, foreign keys enforced', () => {
    const db = openDb(path.join(dir, 'c.sqlite'));
    makeUser(db, { email: 'Sarah@Example.com' });
    assert.throws(() => makeUser(db, { email: 'sarah@example.com' }), /UNIQUE/);
    assert.throws(() => makeUser(db, { role: 'owner' }), /CHECK/);
    assert.throws(
      () =>
        db
          .prepare("INSERT INTO items (id, user_id, kind, created_at) VALUES (?, 'nobody', 'photo', 1)")
          .run(newId()),
      /FOREIGN KEY/,
    );
    db.close();
  });

  test('migrations run in name order and stop on a broken file', async () => {
    const migrations = path.join(dir, 'migrations');
    await fs.mkdir(migrations);
    await fs.writeFile(path.join(migrations, '002_b.sql'), 'INSERT INTO t (v) VALUES (2);');
    await fs.writeFile(path.join(migrations, '001_a.sql'), 'CREATE TABLE t (v INTEGER);');
    await fs.writeFile(path.join(migrations, 'notes.txt'), 'ignored');
    assert.deepEqual(listMigrations(migrations), ['001_a.sql', '002_b.sql']);
    const db = openDb(path.join(dir, 'd.sqlite'), { migrationsDir: migrations });
    assert.deepEqual(db.prepare('SELECT v FROM t').all(), [{ v: 2 }]);

    await fs.writeFile(path.join(migrations, '003_broken.sql'), 'INSERT INTO t (v) VALUES (3); NOT SQL;');
    assert.throws(() => migrate(db, migrations), /Migration 003_broken.sql failed/);
    assert.deepEqual(db.prepare('SELECT v FROM t').all(), [{ v: 2 }], 'the broken file rolled back whole');
    db.close();
  });
});

describe('ids, tokens and time', () => {
  test('newId makes sortable ULIDs, in order within a millisecond', () => {
    const t = Date.UTC(2026, 9, 22, 12);
    const ids = Array.from({ length: 50 }, () => newId(t));
    assert.ok(ids.every(isId));
    assert.deepEqual([...ids].sort(), ids);
    assert.equal(new Set(ids).size, 50);
    assert.equal(idTime(ids[0]), t);
    assert.ok(newId(t + 1) > ids.at(-1));
    assert.equal(isId('not-an-id'), false);
  });

  test('tokens, hashes and comparison', () => {
    const token = randomToken();
    assert.match(token, /^[A-Za-z0-9_-]{43}$/);
    assert.notEqual(randomToken(), token);
    assert.equal(sha256('abc'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    assert.notEqual(hmac('key-one', '123456'), hmac('key-two', '123456'));
    assert.equal(hmac('key-one', '123456'), hmac('key-one', '123456'));
    assert.ok(safeEqual('same', 'same'));
    assert.equal(safeEqual('same', 'Same'), false);
    assert.equal(safeEqual('short', 'longer value'), false);
    assert.equal(safeEqual(undefined, 'x'), false);
    const code = randomDigits(6);
    assert.match(code, /^\d{6}$/);
  });

  test('night windows cross midnight and follow the time zone', () => {
    assert.equal(inWindow('22:30', '21:00', '07:00'), true);
    assert.equal(inWindow('06:59', '21:00', '07:00'), true);
    assert.equal(inWindow('07:00', '21:00', '07:00'), false);
    assert.equal(inWindow('12:00', '09:00', '17:00'), true);
    assert.equal(inWindow('12:00', '09:00', '09:00'), false);
    assert.throws(() => inWindow('25:00', '21:00', '07:00'), RangeError);
    const t = Date.UTC(2026, 9, 22, 3, 0); // 22:00 the evening before in Chicago (CDT, UTC-5)
    assert.equal(clockInZone(t, 'America/Chicago'), '22:00');
    assert.equal(isNight(t, { night_start: '21:00', night_end: '07:00', timezone: 'America/Chicago' }), true);
    assert.equal(isNight(t, { night_start: '21:00', night_end: '07:00', timezone: 'Asia/Tokyo' }), false);
  });
});

describe('settings, storage and redaction', () => {
  let dir;
  let db;
  before(async () => {
    dir = await makeTempDir();
    db = openDb(path.join(dir, 's.sqlite'));
  });
  after(async () => {
    db.close();
    await fs.rm(dir, { recursive: true, force: true });
  });

  test('settings round-trip as JSON with defaults', () => {
    setSetting(db, 'worker_last_seen', 123);
    assert.equal(getSetting(db, 'worker_last_seen'), 123);
    assert.equal(getSetting(db, 'missing'), null);
    assert.equal(getSetting(db, 'missing', 'fallback'), 'fallback');
    setSettings(db, { night_start: '22:00', family_photo: { item_id: 'x' } });
    const all = getSettings(db);
    assert.equal(all.night_start, '22:00');
    assert.deepEqual(all.family_photo, { item_id: 'x' });
    assert.deepEqual(getSettings(db, ['night_end']), { night_end: '07:00' });
  });

  test('storage builds keys under MEDIA_DIR and refuses to escape it', async () => {
    const storage = createStorage(path.join(dir, 'media'));
    await storage.init();
    for (const sub of ['originals', 'renditions', 'uploads']) {
      assert.ok((await fs.stat(path.join(dir, 'media', sub))).isDirectory());
    }
    const id = newId();
    const createdAt = Date.UTC(2026, 0, 5);
    assert.equal(storage.originalKey(id, '.HEIC', createdAt), `originals/2026/01/${id}.heic`);
    assert.equal(storage.renditionKey(id, 'thumb', 'webp'), `renditions/${id}/thumb.webp`);
    const abs = await storage.ensureDirFor(storage.renditionKey(id, 'display', 'jpg'));
    assert.ok(abs.startsWith(storage.renditionsDir));
    assert.ok(storage.tempPathFor(`renditions/${id}/display.jpg`).includes('.tmp-'));
    assert.throws(() => storage.resolve('../etc/passwd'), UnsafePathError);
    assert.throws(() => storage.resolve('/etc/passwd'), UnsafePathError);
    assert.throws(() => storage.renditionKey('../x', 'thumb', 'webp'), UnsafePathError);
    assert.throws(() => storage.originalKey(id, 'j/pg'), UnsafePathError);
    assert.throws(() => safeJoin('/media', '..', 'data'), UnsafePathError);
    await fs.writeFile(abs, 'x');
    await storage.removeRenditions(id);
    await assert.rejects(fs.stat(abs));
    await storage.remove(`renditions/${id}/missing.jpg`); // a missing file is fine
  });

  test('redactUrl hides pairing tokens and codes', () => {
    assert.equal(redactUrl('/grandma?device=abc123'), '/grandma?device=REDACTED');
    assert.equal(redactUrl('/confirm?t=xyz&next=%2F'), '/confirm?t=REDACTED&next=%2F');
    assert.equal(redactUrl('/x?TOKEN=1&code=2&keep=3'), '/x?TOKEN=REDACTED&code=REDACTED&keep=3');
    assert.equal(redactUrl('/api/items?before=01ABC'), '/api/items?before=01ABC');
    assert.equal(redactUrl('/plain'), '/plain');
    assert.equal(stripSecretParams('/grandma/?device=abc&x=1'), '/grandma/?x=1');
    assert.equal(stripSecretParams('/mine?t=1'), '/mine');
  });
});

describe('email', () => {
  test('captureEmails collects mail for one config only', async () => {
    const dir = await makeTempDir();
    const config = makeTestConfig(dir);
    const other = makeTestConfig(dir);
    const box = captureEmails(config);
    const msg = signInCodeEmail({ name: 'Sarah', code: '042917', confirmUrl: 'http://localhost:8080/confirm?t=abc' });
    await sendEmail(config, { to: 'sarah@example.com', ...msg });
    assert.equal(box.length, 1);
    assert.equal(box[0].to, 'sarah@example.com');
    assert.match(box[0].subject, /042917/);
    assert.match(box[0].text, /042917/);
    assert.match(box[0].text, /confirm\?t=abc/);
    assert.match(box[0].html, /Sign in on this phone/);
    assert.equal(captureEmails(other).length, 0);
    await fs.rm(dir, { recursive: true, force: true });
  });

  test('templates escape names in HTML', () => {
    const invite = inviteEmail({ name: '<b>Lily</b>', inviterName: 'Ben', joinUrl: 'https://gma.4mn.org/join/t' });
    assert.equal(invite.subject, "Ben invited you to Grandma's family");
    assert.ok(invite.html.includes('&lt;b&gt;Lily&lt;/b&gt;'));
    assert.ok(!invite.html.includes('<b>Lily</b>'));
    assert.match(invite.text, /14 days/);
  });

  test('the resend transport posts JSON and never echoes the response body', async (t) => {
    const config = loadConfig({ NODE_ENV: 'test', EMAIL_TRANSPORT: 'resend', RESEND_API_KEY: 're_test' });
    const calls = [];
    t.mock.method(globalThis, 'fetch', async (url, init) => {
      calls.push({ url, init });
      return new Response(JSON.stringify({ id: 'email_1' }), { status: 200 });
    });
    const result = await sendEmail(config, { to: 'a@example.com', subject: 'Hi', text: 'Hello', html: '<p>Hello</p>' });
    assert.equal(result.id, 'email_1');
    assert.equal(calls[0].url, 'https://api.resend.com/emails');
    assert.equal(calls[0].init.headers.authorization, 'Bearer re_test');
    assert.deepEqual(JSON.parse(calls[0].init.body).to, ['a@example.com']);

    globalThis.fetch.mock.mockImplementation(async () => new Response('secret code 123456', { status: 422 }));
    await assert.rejects(sendEmail(config, { to: 'a@example.com', subject: 'Hi', text: 'x' }), (err) => {
      assert.ok(err instanceof EmailError);
      assert.equal(err.status, 422);
      assert.ok(!err.message.includes('123456'));
      return true;
    });
  });
});

describe('events', () => {
  let dir;
  let db;
  before(async () => {
    dir = await makeTempDir();
    db = openDb(path.join(dir, 'e.sqlite'));
  });
  after(async () => {
    db.close();
    await fs.rm(dir, { recursive: true, force: true });
  });

  test('publish stores the payload and checks the audience', () => {
    const id = publish(db, 'item.ready', { item_id: 'x' });
    const [event] = eventsAfter(db, id - 1);
    assert.equal(event.topic, 'item.ready');
    assert.equal(event.audience, 'all');
    assert.deepEqual(event.payload, { item_id: 'x' });
    assert.throws(() => publish(db, 'x', {}, 'everyone'), /audience/);
    assert.throws(() => publish(db, '', {}), /topic/);
  });

  test('audienceMatches', () => {
    const user = { userId: 'u1' };
    const device = { deviceId: 'd1' };
    assert.ok(audienceMatches('all', user) && audienceMatches('all', device));
    assert.ok(audienceMatches('devices', device) && !audienceMatches('devices', user));
    assert.ok(audienceMatches('user:u1', user) && !audienceMatches('user:u2', user) && !audienceMatches('user:u1', device));
    assert.ok(audienceMatches('device:d1', device) && !audienceMatches('device:d1', user));
  });

  test('the hub fans new rows out by audience, and only while someone listens', () => {
    const hub = createEventHub(db, { intervalMs: 60_000 });
    publish(db, 'old', {}); // before anyone subscribed: not delivered
    const userSeen = [];
    const deviceSeen = [];
    const offUser = hub.subscribe({ userId: 'u1' }, (e) => userSeen.push(e.topic));
    const offDevice = hub.subscribe({ deviceId: 'd1' }, (e) => deviceSeen.push(e.topic));
    publish(db, 'item.ready', {});
    publish(db, 'frame.reload', {}, 'devices');
    publish(db, 'item.failed', {}, 'user:u1');
    publish(db, 'item.failed', {}, 'user:u2');
    hub.poll();
    assert.deepEqual(userSeen, ['item.ready', 'item.failed']);
    assert.deepEqual(deviceSeen, ['item.ready', 'frame.reload']);
    offUser();
    offDevice();
    assert.equal(hub.size, 0);
    hub.close();
  });

  test('pruneEvents drops rows older than 7 days', () => {
    db.prepare("INSERT INTO events (topic, audience, payload, created_at) VALUES ('ancient', 'all', '{}', ?)").run(
      Date.now() - 8 * 24 * 3600 * 1000,
    );
    assert.ok(pruneEvents(db) >= 1);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM events WHERE topic = 'ancient'").get().n, 0);
  });
});

describe('sessions', () => {
  let dir;
  let db;
  before(async () => {
    dir = await makeTempDir();
    db = openDb(path.join(dir, 'sess.sqlite'));
  });
  after(async () => {
    db.close();
    await fs.rm(dir, { recursive: true, force: true });
  });

  test('a user session loads, stores only a hash, and can be destroyed', () => {
    const user = makeUser(db);
    const { token, id, expiresAt } = createSession(db, { kind: 'user', userId: user.id, userAgent: 'Safari' });
    const row = db.prepare('SELECT * FROM sessions WHERE id = ?').get(id);
    assert.equal(row.token_hash, sha256(token));
    assert.ok(!JSON.stringify(row).includes(token));
    assert.ok(Math.abs(expiresAt - (Date.now() + SESSION_MAX_AGE_SECONDS * 1000)) < 5000);
    const auth = loadSession(db, token);
    assert.equal(auth.user.id, user.id);
    assert.equal(auth.device, null);
    assert.equal(auth.renewed, false);
    assert.equal(loadSession(db, 'wrong-token-wrong-token'), null);
    assert.equal(destroySession(db, token), 1);
    assert.equal(loadSession(db, token), null);
  });

  test('removed users, revoked devices and expired sessions are rejected', () => {
    const removed = makeUser(db, { status: 'removed' });
    const s1 = createSession(db, { kind: 'user', userId: removed.id });
    assert.equal(loadSession(db, s1.token), null);

    const device = makeDevice(db);
    const s2 = createSession(db, { kind: 'device', deviceId: device.id });
    const auth = loadSession(db, s2.token);
    assert.equal(auth.device.id, device.id);
    db.prepare('UPDATE devices SET revoked_at = ? WHERE id = ?').run(Date.now(), device.id);
    assert.equal(loadSession(db, s2.token), null);

    const user = makeUser(db);
    const s3 = createSession(db, { kind: 'user', userId: user.id });
    db.prepare('UPDATE sessions SET expires_at = ? WHERE id = ?').run(Date.now() - 1, s3.id);
    assert.equal(loadSession(db, s3.token), null);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM sessions WHERE id = ?').get(s3.id).n, 0, 'expired rows are deleted');
  });

  test('past half its life a session slides forward', () => {
    const user = makeUser(db);
    const { token, id } = createSession(db, { kind: 'user', userId: user.id });
    const soon = Date.now() + 10 * 24 * 3600 * 1000;
    db.prepare('UPDATE sessions SET expires_at = ?, last_seen_at = 0 WHERE id = ?').run(soon, id);
    const auth = loadSession(db, token);
    assert.equal(auth.renewed, true);
    const row = db.prepare('SELECT * FROM sessions WHERE id = ?').get(id);
    assert.ok(row.expires_at > soon + 300 * 24 * 3600 * 1000);
    assert.ok(row.last_seen_at > 0);
  });

  test('revoking a user or a device signs them out everywhere', () => {
    const user = makeUser(db);
    const a = createSession(db, { kind: 'user', userId: user.id });
    const b = createSession(db, { kind: 'user', userId: user.id });
    assert.equal(revokeUserSessions(db, user.id), 2);
    assert.equal(loadSession(db, a.token), null);
    assert.equal(loadSession(db, b.token), null);
    const device = makeDevice(db);
    const c = createSession(db, { kind: 'device', deviceId: device.id });
    assert.equal(revokeDeviceSessions(db, device.id), 1);
    assert.equal(loadSession(db, c.token), null);
  });

  test('createSession checks its arguments', () => {
    assert.throws(() => createSession(db, { kind: 'user' }), /userId/);
    assert.throws(() => createSession(db, { kind: 'device' }), /deviceId/);
    assert.throws(() => createSession(db, { kind: 'robot', userId: 'x' }), /kind/);
  });
});
