// Short names for Grandma, cancelling a half-finished invite, the Pi's display
// endpoint, SSE streams that notice a removed person, the nightly database
// snapshot and jobs whose item vanished.

import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, before, describe, test } from 'node:test';
import Database from 'better-sqlite3';
import { migrate, openDb } from '../src/db/index.js';
import { enqueue } from '../src/jobs/queue.js';
import { startRunner } from '../src/jobs/runner.js';
import * as imageJob from '../src/jobs/image.js';
import { localDate, pruneSnapshots, snapshotIfDue } from '../src/jobs/snapshot.js';
import { newId } from '../src/lib/ids.js';
import { setSetting } from '../src/lib/settings.js';
import { loginAs, loginAsDevice, makeDevice, makeTempDir, makeTestApp, makeUser } from './helpers/index.js';

const MIGRATIONS = fileURLToPath(new URL('../src/db/migrations/', import.meta.url));

function makeReadyPhoto(db, user, { createdAt = Date.now() } = {}) {
  const id = newId(createdAt);
  db.prepare(
    `INSERT INTO items (id, user_id, kind, status, width, height, original_path, original_mime, created_at, ready_at)
     VALUES (?, ?, 'photo', 'ready', 1600, 1200, ?, 'image/jpeg', ?, ?)`,
  ).run(id, user.id, `originals/2026/10/${id}.jpg`, createdAt, createdAt);
  db.prepare(
    `INSERT INTO renditions (item_id, name, path, mime, width, height, bytes)
     VALUES (?, 'display', ?, 'image/jpeg', 1600, 1200, 10)`,
  ).run(id, `renditions/${id}/display.jpg`);
  return { id, ready_at: createdAt };
}

describe('migration 002: short names', () => {
  test('backfills the first word of each name, fills new rows and follows a default on rename', async (t) => {
    const dir = await makeTempDir();
    t.after(() => fs.rm(dir, { recursive: true, force: true }));
    // A database made before 002 existed.
    const onlyFirst = path.join(dir, 'migrations');
    await fs.mkdir(onlyFirst);
    await fs.copyFile(path.join(MIGRATIONS, '001_init.sql'), path.join(onlyFirst, '001_init.sql'));
    const db = openDb(path.join(dir, 'gma.sqlite'), { migrationsDir: onlyFirst });
    t.after(() => db.close());
    const before = makeUser(db, { name: 'Michael  Torres' });
    const single = makeUser(db, { name: 'Nana' });

    assert.equal(migrate(db, MIGRATIONS)[0], '002_short_names.sql');
    const shortOf = (id) => db.prepare('SELECT short_name FROM users WHERE id = ?').get(id).short_name;
    assert.equal(shortOf(before.id), 'Michael');
    assert.equal(shortOf(single.id), 'Nana');

    const fresh = makeUser(db, { name: 'Sarah Lee' });
    assert.equal(shortOf(fresh.id), 'Sarah', 'a new row gets the default');

    db.prepare('UPDATE users SET name = ? WHERE id = ?').run('Sally Lee', fresh.id);
    assert.equal(shortOf(fresh.id), 'Sally', 'a default short name follows the new name');

    db.prepare('UPDATE users SET short_name = ? WHERE id = ?').run('Mikey', before.id);
    db.prepare('UPDATE users SET name = ? WHERE id = ?').run('Mike Torres', before.id);
    assert.equal(shortOf(before.id), 'Mikey', 'a short name Ben chose is kept');
  });
});

describe('short names in the API', () => {
  let t;
  let admin;
  let adminCookie;
  let frameCookie;
  before(async () => {
    t = await makeTestApp();
    admin = makeUser(t.db, { name: 'Ben Lee', role: 'admin' });
    adminCookie = loginAs(t.app, t.db, admin);
    frameCookie = loginAsDevice(t.app, t.db, makeDevice(t.db));
  });
  after(() => t.cleanup());

  const patch = (id, body, cookie = adminCookie) =>
    t.app.inject({ method: 'PATCH', url: `/api/admin/people/${id}`, headers: { cookie }, payload: body });

  test('Ben can change what Grandma calls someone, and the frame shows it', async () => {
    const mike = makeUser(t.db, { name: 'Michael Torres' });
    const photo = makeReadyPhoto(t.db, mike);

    let res = await patch(mike.id, { short_name: '  Mikey  ' });
    assert.equal(res.statusCode, 200, res.body);
    assert.equal(res.headers['cache-control'], 'no-store');
    assert.deepEqual([res.json().user.name, res.json().user.short_name], ['Michael Torres', 'Mikey']);
    const log = t.db.prepare("SELECT * FROM admin_log WHERE action = 'person.update' AND target = ?").get(mike.id);
    assert.ok(log);

    const state = (await t.app.inject({ url: '/api/frame/state', headers: { cookie: frameCookie } })).json();
    const slide = state.slideshow.find((i) => i.id === photo.id);
    assert.deepEqual(slide.sender, { id: mike.id, name: 'Mikey', short_name: 'Mikey', full_name: 'Michael Torres' });
    const card = state.new.find((c) => c.items.some((i) => i.id === photo.id));
    assert.equal(card.title, 'Photo from Mikey');
    assert.equal(state.family_photo.sender.name, 'Mikey');

    // The family's views carry both names.
    const items = (await t.app.inject({ url: '/api/items', headers: { cookie: adminCookie } })).json().items;
    const mine = items.find((i) => i.id === photo.id);
    assert.deepEqual([mine.user.name, mine.user.short_name], ['Michael Torres', 'Mikey']);
    const people = (await t.app.inject({ url: '/api/admin/people', headers: { cookie: adminCookie } })).json().people;
    assert.equal(people.find((p) => p.id === mike.id).short_name, 'Mikey');
  });

  test('a rename keeps a chosen short name; both can change at once', async () => {
    const sarah = makeUser(t.db, { name: 'Sarah Lee' });
    let res = await patch(sarah.id, { name: 'Sally Lee' });
    assert.deepEqual([res.json().user.name, res.json().user.short_name], ['Sally Lee', 'Sally']);
    res = await patch(sarah.id, { name: 'Sarah Lee-Park', short_name: 'Sare' });
    assert.deepEqual([res.json().user.name, res.json().user.short_name], ['Sarah Lee-Park', 'Sare']);
    res = await patch(sarah.id, { name: 'Sarah Park' });
    assert.equal(res.json().user.short_name, 'Sare');
  });

  test('bad input is a readable 400; members and unknown people are refused', async () => {
    const someone = makeUser(t.db);
    assert.equal((await patch(someone.id, {})).json().error.code, 'nothing_to_save');
    assert.equal((await patch(someone.id, { short_name: '   ' })).json().error.code, 'name_required');
    assert.equal((await patch(someone.id, { short_name: 'x'.repeat(31) })).json().error.code, 'name_too_long');
    assert.equal((await patch(newId(), { short_name: 'Al' })).statusCode, 404);
    const member = makeUser(t.db);
    assert.equal((await patch(someone.id, { short_name: 'Al' }, loginAs(t.app, t.db, member))).statusCode, 403);
  });
});

describe('cancelling an invite whose person never finished signing in', () => {
  let t;
  let cookie;
  before(async () => {
    t = await makeTestApp();
    cookie = loginAs(t.app, t.db, makeUser(t.db, { name: 'Ben', role: 'admin' }));
  });
  after(() => t.cleanup());

  test('revokes the invite and its codes, and forgets the pending person', async () => {
    const made = await t.app.inject({
      method: 'POST',
      url: '/api/admin/invites',
      headers: { cookie },
      payload: { name: 'Aunt May', email: 'may@example.com' },
    });
    assert.equal(made.statusCode, 201, made.body);
    const { invite, url } = made.json();
    const token = url.split('/join/')[1];

    const accepted = await t.app.inject({
      method: 'POST',
      url: `/api/invites/${token}/accept`,
      payload: { name: 'Aunt May', email: 'may@example.com' },
    });
    assert.equal(accepted.json().signed_in, false);
    const pending = t.db.prepare('SELECT * FROM users WHERE email = ?').get('may@example.com');
    assert.equal(pending.status, 'pending');
    assert.equal(t.db.prepare('SELECT COUNT(*) AS n FROM login_codes WHERE user_id = ?').get(pending.id).n, 1);

    const res = await t.app.inject({ method: 'DELETE', url: `/api/admin/invites/${invite.id}`, headers: { cookie } });
    assert.equal(res.statusCode, 200, res.body);
    assert.ok(res.json().invite.revoked_at);
    assert.equal(t.db.prepare('SELECT COUNT(*) AS n FROM login_codes WHERE user_id = ?').get(pending.id).n, 0);
    assert.equal(t.db.prepare('SELECT * FROM users WHERE id = ?').get(pending.id), undefined);

    const lookup = (await t.app.inject({ url: `/api/invites/${token}` })).json();
    assert.deepEqual([lookup.valid, lookup.reason], [false, 'revoked']);

    // Ben can invite them again straight away.
    const again = await t.app.inject({
      method: 'POST',
      url: '/api/admin/invites',
      headers: { cookie },
      payload: { name: 'Aunt May', email: 'may@example.com' },
    });
    assert.equal(again.statusCode, 201, again.body);
  });

  test('an invite whose person finished signing in still cannot be cancelled', async () => {
    const member = makeUser(t.db);
    const id = newId();
    t.db.prepare(
      `INSERT INTO invites (id, token_hash, created_by, name, email, role, expires_at, used_at, used_by, created_at)
       VALUES (?, ?, NULL, 'X', ?, 'member', ?, ?, ?, ?)`,
    ).run(id, `hash-${id}`, member.email, Date.now() + 1e9, Date.now(), member.id, Date.now());
    const res = await t.app.inject({ method: 'DELETE', url: `/api/admin/invites/${id}`, headers: { cookie } });
    assert.equal(res.statusCode, 409);
    assert.equal(res.json().error.code, 'invite_used');
  });
});

describe('GET /api/frame/display', () => {
  let t;
  let device;
  before(async () => {
    t = await makeTestApp();
    device = makeDevice(t.db);
  });
  after(() => t.cleanup());

  const display = (headers = {}) => t.app.inject({ url: '/api/frame/display', headers });

  test('answers the frame cookie or the pairing token, with the night hours and brightness', async () => {
    const res = await display({ cookie: loginAsDevice(t.app, t.db, device) });
    assert.equal(res.statusCode, 200, res.body);
    assert.equal(res.headers['cache-control'], 'no-store');
    const body = res.json();
    assert.deepEqual(Object.keys(body).sort(), ['brightness_day', 'brightness_night', 'night', 'night_end', 'night_start', 'now', 'timezone']);
    assert.deepEqual([body.night_start, body.night_end, body.timezone], ['21:00', '07:00', 'America/Chicago']);
    assert.deepEqual([body.brightness_day, body.brightness_night], [100, 25]);
    assert.equal(typeof body.night, 'boolean');

    const lastSeen = t.db.prepare('SELECT last_seen_at FROM devices WHERE id = ?').get(device.id).last_seen_at;
    const bearer = await display({ authorization: `Bearer ${device.token}` });
    assert.equal(bearer.statusCode, 200, bearer.body);
    assert.equal(t.db.prepare('SELECT last_seen_at FROM devices WHERE id = ?').get(device.id).last_seen_at, lastSeen,
      'the helper does not count as the frame being seen');
  });

  test('night follows the settings', async () => {
    setSetting(t.db, 'night_start', '00:00');
    setSetting(t.db, 'night_end', '23:59');
    const always = (await display({ authorization: `Bearer ${device.token}` })).json();
    setSetting(t.db, 'night_start', '21:00');
    setSetting(t.db, 'night_end', '07:00');
    // 00:00 to 23:59 covers every minute but the last one of the day.
    assert.equal(always.night, new Intl.DateTimeFormat('en-GB', { timeZone: 'America/Chicago', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(always.now)) !== '23:59');
  });

  test('no session, a bad token, a revoked frame or a family member are refused', async () => {
    assert.equal((await display()).statusCode, 401);
    assert.equal((await display({ authorization: 'Bearer not-a-real-token-at-all-nope' })).statusCode, 401);
    const gone = makeDevice(t.db, { revoked_at: Date.now() });
    assert.equal((await display({ authorization: `Bearer ${gone.token}` })).statusCode, 401);
    assert.equal((await display({ cookie: loginAs(t.app, t.db, makeUser(t.db)) })).statusCode, 401);
  });
});

describe('live streams re-check their session', () => {
  let t;
  let base;
  before(async () => {
    t = await makeTestApp({ routeOptions: { sseSessionCheckMs: 40 } });
    base = await t.app.listen({ host: '127.0.0.1', port: 0 });
  });
  after(() => t.cleanup());

  function streamEnds(cookie, change) {
    return new Promise((resolve, reject) => {
      const req = http.get(`${base}/api/events`, { headers: { cookie } }, (res) => {
        assert.equal(res.statusCode, 200);
        res.on('data', () => {});
        res.on('end', () => resolve(true));
        setTimeout(change, 60);
      });
      req.on('error', reject);
      setTimeout(() => {
        req.destroy();
        resolve(false);
      }, 2000);
    });
  }

  test('a removed person loses the stream', async () => {
    const user = makeUser(t.db);
    const ended = await streamEnds(loginAs(t.app, t.db, user), () =>
      t.db.prepare("UPDATE users SET status = 'removed' WHERE id = ?").run(user.id),
    );
    assert.equal(ended, true);
  });

  test('an unpaired frame loses the stream', async () => {
    const device = makeDevice(t.db);
    const ended = await streamEnds(loginAsDevice(t.app, t.db, device), () =>
      t.db.prepare('UPDATE devices SET revoked_at = ? WHERE id = ?').run(Date.now(), device.id),
    );
    assert.equal(ended, true);
  });

  test('a stream whose session is fine stays open', async () => {
    const ended = await new Promise((resolve) => {
      const req = http.get(`${base}/api/events`, { headers: { cookie: loginAs(t.app, t.db, makeUser(t.db)) } }, (res) => {
        res.on('data', () => {});
        res.on('end', () => resolve(true));
      });
      setTimeout(() => {
        req.destroy();
        resolve(false);
      }, 300);
    });
    assert.equal(ended, false);
  });
});

describe('the worker', () => {
  test('a job whose item was deleted while it ran is done, not failed', async (t) => {
    const ctx = await makeTestApp();
    t.after(() => ctx.cleanup());
    const user = makeUser(ctx.db);
    const item = makeReadyPhoto(ctx.db, user);
    enqueue(ctx.db, { kind: 'image', refId: item.id });
    const failed = [];
    const handler = {
      async run({ db }, job) {
        db.prepare('DELETE FROM items WHERE id = ?').run(job.ref_id);
        throw Object.assign(new Error('ENOENT: no such file'), { code: 'ENOENT' });
      },
      isGone: imageJob.isGone,
      onFailed: (_ctx, job) => failed.push(job.ref_id),
    };
    const runner = startRunner({ config: ctx.config, db: ctx.db, storage: ctx.app.storage, handlers: { image: handler }, pollMs: 60_000, snapshots: false });
    t.after(() => runner.stop());
    runner.tick();
    await runner.drain();
    const job = ctx.db.prepare('SELECT status, error FROM jobs WHERE ref_id = ?').get(item.id);
    assert.deepEqual([job.status, job.error], ['done', null]);
    assert.deepEqual(failed, []);
  });

  test('the nightly snapshot: once a day after 03:15, a restorable copy, the newest 7 kept, shown in health', async (t) => {
    const ctx = await makeTestApp();
    t.after(() => ctx.cleanup());
    const { db, config } = ctx;
    const admin = makeUser(db, { name: 'Ben', role: 'admin' });
    // 2026-10-22 in Chicago (CDT, UTC-5): 02:00 is too early, 03:30 is due.
    const early = Date.parse('2026-10-22T07:00:00Z');
    const due = Date.parse('2026-10-22T08:30:00Z');
    assert.equal(localDate(due, 'America/Chicago'), '2026-10-22');

    assert.equal(await snapshotIfDue({ db, config, now: early }), null);
    const made = await snapshotIfDue({ db, config, now: due });
    assert.equal(made.file, 'backups/gma-2026-10-22.sqlite');
    assert.equal(await snapshotIfDue({ db, config, now: due + 60_000 }), null, 'once a day');

    const file = path.join(config.mediaDir, made.file);
    const copy = new Database(file, { readonly: true });
    try {
      assert.equal(copy.prepare('SELECT name FROM users WHERE id = ?').get(admin.id).name, 'Ben');
      assert.equal(copy.pragma('journal_mode', { simple: true }), 'delete');
    } finally {
      copy.close();
    }
    const leftovers = (await fs.readdir(path.dirname(file))).filter((n) => n.startsWith('.'));
    assert.deepEqual(leftovers, [], 'no temp file is left behind');

    const health = await ctx.app.inject({ url: '/api/admin/health', headers: { cookie: loginAs(ctx.app, db, admin) } });
    assert.equal(health.json().last_snapshot_at, made.at);
    assert.equal(health.json().last_snapshot.file, made.file);

    const dir = path.dirname(file);
    for (let d = 10; d <= 21; d += 1) await fs.writeFile(path.join(dir, `gma-2026-10-${String(d).padStart(2, '0')}.sqlite`), '');
    await pruneSnapshots(dir);
    const kept = (await fs.readdir(dir)).filter((n) => n.endsWith('.sqlite')).sort();
    assert.equal(kept.length, 7);
    assert.equal(kept.at(-1), 'gma-2026-10-22.sqlite');
    assert.equal(kept[0], 'gma-2026-10-16.sqlite');
  });

  test('a second worker never snapshots the same day while the first holds the claim', async (t) => {
    const ctx = await makeTestApp();
    t.after(() => ctx.cleanup());
    const due = Date.parse('2026-10-22T08:30:00Z');
    setSetting(ctx.db, 'snapshot_claim', { day: '2026-10-22', at: due - 60_000, done: false });
    assert.equal(await snapshotIfDue({ db: ctx.db, config: ctx.config, now: due }), null);
    // A claim older than 30 minutes is a worker that died: the next one takes over.
    const later = due + 31 * 60_000;
    assert.ok(await snapshotIfDue({ db: ctx.db, config: ctx.config, now: later }));
  });

  test('a snapshot is never written onto an unplugged drive, and nothing is claimed', async (t) => {
    const ctx = await makeTestApp();
    t.after(() => ctx.cleanup());
    const due = Date.parse('2026-10-22T08:30:00Z');
    // The drive's sentinel is missing (an empty mount point): refuse, write nothing.
    const config = { ...ctx.config, mediaSentinel: '.gma-media' };
    await fs.rm(path.join(config.mediaDir, 'backups'), { recursive: true, force: true });
    await assert.rejects(snapshotIfDue({ db: ctx.db, config, now: due }), { code: 'media_not_mounted' });
    await assert.rejects(fs.stat(path.join(config.mediaDir, 'backups')), { code: 'ENOENT' });
    assert.equal(ctx.db.prepare("SELECT value FROM settings WHERE key = 'snapshot_claim'").get(), undefined);
    // Once the drive is back the day's snapshot is made.
    await fs.writeFile(path.join(config.mediaDir, '.gma-media'), '');
    assert.equal((await snapshotIfDue({ db: ctx.db, config, now: due })).day, '2026-10-22');
  });
});
