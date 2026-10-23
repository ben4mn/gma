// The reliability round (OPS-*): each test here failed on the code before its fix.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test, describe } from 'node:test';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { openDb } from '../src/db/index.js';
import { immediate } from '../src/lib/tx.js';

const SRC = fileURLToPath(new URL('../src/', import.meta.url));

function walk(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return walk(full);
    return entry.name.endsWith('.js') ? [full] : [];
  });
}

describe('OPS-13: write transactions start IMMEDIATE', () => {
  test('immediate() holds the write lock from the first statement, even before it writes', async () => {
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'gma-tx-'));
    const file = path.join(dir, 'tx.sqlite');
    const a = openDb(file, { migrate: false });
    const b = new Database(file);
    b.pragma('busy_timeout = 0');
    try {
      a.exec('CREATE TABLE t (n INTEGER)');
      const result = immediate(a, () => {
        a.prepare('SELECT COUNT(*) AS n FROM t').get(); // a read only, so far
        assert.throws(() => b.exec('BEGIN IMMEDIATE'), /busy|locked/i);
        a.prepare('INSERT INTO t (n) VALUES (1)').run();
        return 'done';
      });
      assert.equal(result, 'done');
      b.exec('BEGIN IMMEDIATE');
      b.exec('ROLLBACK');
    } finally {
      a.close();
      b.close();
      await fsp.rm(dir, { recursive: true, force: true });
    }
  });

  test('no source file opens a deferred transaction (db.transaction(…)() ) any more', () => {
    const offenders = [];
    for (const file of walk(SRC)) {
      if (file.endsWith(path.join('lib', 'tx.js'))) continue;
      const text = fs.readFileSync(file, 'utf8');
      for (const [i, line] of text.split('\n').entries()) {
        if (/\.transaction\(/.test(line) && !/^\s*\/\//.test(line)) offenders.push(`${path.relative(SRC, file)}:${i + 1}`);
      }
    }
    // Migrations and the snapshot claim already used .immediate(); everything goes through lib/tx.js now.
    assert.deepEqual(offenders, []);
  });
});

describe('OPS-1: HDR video is scaled before the tone map, and the time limit follows the clip', async () => {
  const media = await import('../src/lib/media.js');

  test('the tone map comes after the 720p scale, once', () => {
    const vf = media.videoFilter({ hdr: true });
    assert.ok(vf.startsWith(media.SCALE_FILTER + ','), vf);
    assert.ok(vf.indexOf('tonemap') > vf.indexOf(media.SCALE_FILTER), vf);
    assert.equal(vf.split('scale=w=').length - 1, 1, 'one scale');
    assert.ok(vf.endsWith(',format=yuv420p'), vf);
    assert.equal(media.videoFilter({ hdr: false }), `${media.SCALE_FILTER},format=yuv420p`);
  });

  test('the transcode limit is proportional to the probed duration, with a 10-minute floor', () => {
    const MIN = 60_000;
    // A 3-minute clip gets 30 s of work per second of video, far past the old fixed 30 minutes.
    assert.equal(media.videoTimeoutMs({ durationMs: 180_000, maxSeconds: 180 }), 90 * MIN);
    assert.equal(media.videoTimeoutMs({ durationMs: 5_000, maxSeconds: 180 }), 10 * MIN, 'short clips get the floor');
    // A file claiming to be longer than the limit is cut at the limit plus a second.
    assert.equal(media.videoTimeoutMs({ durationMs: 3_600_000, maxSeconds: 180 }), 181 * 30_000);
    // Unknown duration: the limit (plus the second the -t cap allows).
    assert.equal(media.videoTimeoutMs({ durationMs: null, maxSeconds: 60 }), 61 * 30_000);
  });

  test('transcodeVideo hands ffmpeg that limit for the clip it was given', async () => {
    const calls = [];
    const tools = media.createMediaTools({ exec: async (file, args, opts) => calls.push(opts), which: (n) => `/fake/${n}` });
    await tools.transcodeVideo({ input: 'a', output: 'b', hdr: true, maxSeconds: 180, durationMs: 150_000 });
    assert.equal(calls[0].timeoutMs, 150 * 30_000);
  });
});

// A bare worker setup: a database, a media folder with its sentinel, fake handlers.
async function workerRig() {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'gma-ops-'));
  const { createStorage } = await import('../src/lib/storage.js');
  const mediaDir = path.join(dir, 'media');
  await fsp.mkdir(mediaDir, { recursive: true });
  await fsp.writeFile(path.join(mediaDir, '.gma-media'), '');
  const storage = createStorage(mediaDir, { sentinel: '.gma-media' });
  await storage.init();
  const db = openDb(path.join(dir, 'gma.sqlite'));
  const config = { mediaDir, mediaSentinel: '.gma-media' };
  const logs = [];
  const log = { info: (m) => logs.push(['info', m]), warn: (m) => logs.push(['warn', m]), error: (m) => logs.push(['error', m]) };
  return {
    dir, db, storage, config, log, logs, mediaDir,
    unplug: () => fsp.rm(path.join(mediaDir, '.gma-media')),
    plugIn: () => fsp.writeFile(path.join(mediaDir, '.gma-media'), ''),
    async cleanup() {
      db.close();
      await fsp.rm(dir, { recursive: true, force: true });
    },
  };
}

const job = (db, id) => db.prepare('SELECT * FROM jobs WHERE id = ?').get(id);

describe('OPS-2: jobs a crash left running come back, and poison jobs stop', async () => {
  const { enqueue, claim } = await import('../src/jobs/queue.js');
  const { startRunner } = await import('../src/jobs/runner.js');

  test('at boot, a job left running a minute ago is requeued (the attempt it used stays counted)', async (t) => {
    const rig = await workerRig();
    t.after(rig.cleanup);
    const id = enqueue(rig.db, { kind: 'image', refId: 'item-1', now: Date.now() - 120_000, runAfter: Date.now() - 120_000 });
    assert.ok(claim(rig.db, { workerId: 'dead-worker', now: Date.now() - 60_000 })); // a power cut, one minute ago
    let ran = 0;
    const runner = startRunner({
      config: rig.config, db: rig.db, storage: rig.storage, log: rig.log, snapshots: false, pollMs: 60_000,
      handlers: { image: { run: async () => { ran += 1; } } },
    });
    t.after(() => runner.stop());
    await new Promise((r) => setImmediate(r));
    runner.tick();
    await runner.drain();
    await runner.stop();
    assert.equal(ran, 1);
    const row = job(rig.db, id);
    assert.equal(row.status, 'done');
    assert.equal(row.attempts, 2, 'the interrupted attempt counts');
  });

  test('a job that keeps killing the worker fails for good after its attempts, with the reason kept', async (t) => {
    const rig = await workerRig();
    t.after(rig.cleanup);
    const id = enqueue(rig.db, { kind: 'image', refId: 'item-2' });
    rig.db.prepare("UPDATE jobs SET status = 'running', attempts = 3, locked_at = ?, locked_by = 'dead' WHERE id = ?").run(Date.now() - 1000, id);
    const failed = [];
    let ran = 0;
    const runner = startRunner({
      config: rig.config, db: rig.db, storage: rig.storage, log: rig.log, snapshots: false, pollMs: 60_000,
      handlers: { image: { run: async () => { ran += 1; }, onFailed: async (ctx, j, err) => failed.push([j.id, err.message]) } },
    });
    t.after(() => runner.stop());
    runner.tick();
    await runner.drain();
    await runner.stop();
    assert.equal(ran, 0, 'never run a fourth time');
    const row = job(rig.db, id);
    assert.equal(row.status, 'failed');
    assert.match(row.error, /stopped while/i);
    assert.equal(failed.length, 1);
    assert.equal(failed[0][0], id);
  });

  test('a periodic sweep requeues another worker\'s stale job, never one this worker is running', async (t) => {
    const rig = await workerRig();
    t.after(rig.cleanup);
    const { sweepStale } = await import('../src/jobs/queue.js');
    const now = Date.now();
    const past = now - 4 * 60 * 60_000;
    const stale = enqueue(rig.db, { kind: 'video', refId: 'v1', now: past, runAfter: past });
    const mine = enqueue(rig.db, { kind: 'image', refId: 'i1', now: past, runAfter: past });
    claim(rig.db, { workerId: 'gone', kinds: ['video'], now: now - 3 * 60 * 60_000 });
    claim(rig.db, { workerId: 'me', kinds: ['image'], now: now - 3 * 60 * 60_000 });
    const out = sweepStale(rig.db, { workerId: 'me', now });
    assert.equal(out.requeued, 1);
    assert.equal(job(rig.db, stale).status, 'queued');
    assert.equal(job(rig.db, mine).status, 'running');
  });

  test('bookkeeping that throws in a failed job never becomes an unhandled rejection', async (t) => {
    const rig = await workerRig();
    t.after(rig.cleanup);
    enqueue(rig.db, { kind: 'image', refId: 'item-3' });
    const unhandled = [];
    const onUnhandled = (err) => unhandled.push(err);
    process.on('unhandledRejection', onUnhandled);
    t.after(() => process.off('unhandledRejection', onUnhandled));
    const runner = startRunner({
      config: rig.config, db: rig.db, storage: rig.storage, log: rig.log, snapshots: false, pollMs: 60_000,
      handlers: {
        image: {
          run: async () => { throw new Error('boom'); },
          isGone: () => { throw new Error('unused'); },
        },
      },
    });
    t.after(() => runner.stop());
    const realPrepare = rig.db.prepare.bind(rig.db);
    rig.db.prepare = (sql) => {
      if (/SET status = 'queued', run_after/.test(sql)) throw Object.assign(new Error('database or disk is full'), { code: 'SQLITE_FULL' });
      return realPrepare(sql);
    };
    runner.tick();
    await runner.drain();
    await new Promise((r) => setTimeout(r, 20));
    rig.db.prepare = realPrepare;
    await runner.stop();
    assert.deepEqual(unhandled, []);
    assert.ok(rig.logs.some(([level, m]) => level === 'error' && /disk is full/.test(m)), JSON.stringify(rig.logs));
  });
});

describe('OPS-3: the photo drive dropping at runtime', async () => {
  const { enqueue } = await import('../src/jobs/queue.js');
  const { startRunner } = await import('../src/jobs/runner.js');

  test('the worker stops claiming while the sentinel is gone, and picks up again when it is back', async (t) => {
    const rig = await workerRig();
    t.after(rig.cleanup);
    const id = enqueue(rig.db, { kind: 'image', refId: 'item-4' });
    let ran = 0;
    await rig.unplug(); // the drive drops
    const runner = startRunner({
      config: rig.config, db: rig.db, storage: rig.storage, log: rig.log, snapshots: false, pollMs: 60_000,
      handlers: { image: { run: async () => { ran += 1; } } },
    });
    t.after(() => runner.stop());
    await new Promise((r) => setImmediate(r));
    runner.tick();
    runner.tick();
    await runner.drain();
    assert.equal(ran, 0);
    assert.equal(job(rig.db, id).status, 'queued');
    assert.equal(rig.logs.filter(([, m]) => /photo drive/i.test(m)).length, 1, 'logged once');
    await rig.plugIn();
    runner.tick();
    await runner.drain();
    await runner.stop();
    assert.equal(ran, 1);
    assert.equal(job(rig.db, id).status, 'done');
  });

  test('a job that fails because the drive went away goes back without spending an attempt', async (t) => {
    const rig = await workerRig();
    t.after(rig.cleanup);
    const id = enqueue(rig.db, { kind: 'image', refId: 'item-5' });
    const failed = [];
    const runner = startRunner({
      config: rig.config, db: rig.db, storage: rig.storage, log: rig.log, snapshots: false, pollMs: 60_000,
      handlers: {
        image: {
          run: async () => {
            await rig.unplug();
            throw Object.assign(new Error('EIO: i/o error, read'), { code: 'EIO', permanent: true });
          },
          onFailed: () => failed.push(1),
        },
      },
    });
    t.after(() => runner.stop());
    runner.tick();
    await runner.drain();
    await runner.stop();
    const row = job(rig.db, id);
    assert.equal(row.status, 'queued');
    assert.equal(row.attempts, 0, 'no attempt spent');
    assert.ok(row.run_after > Date.now(), 'tried again later');
    assert.equal(failed.length, 0);
  });

  test('an I/O error reading a photo is not "unreadable" (it is retried)', async () => {
    const { mediaIoError } = await import('../src/jobs/errors.js');
    assert.equal(mediaIoError(Object.assign(new Error('x'), { code: 'EIO' })), true);
    assert.equal(mediaIoError(Object.assign(new Error('x'), { code: 'ENOENT' })), true);
    assert.equal(mediaIoError(new Error('Input buffer contains unsupported image format')), false);
  });

  test('GET /healthz says the media is gone (503), and the worker health check fails', async (t) => {
    const { makeTestApp } = await import('./helpers/index.js');
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'gma-hz-'));
    const media = path.join(dir, 'media');
    await fsp.mkdir(media, { recursive: true });
    await fsp.writeFile(path.join(media, '.gma-media'), '');
    const ctx = await makeTestApp({ env: { MEDIA_DIR: media, MEDIA_SENTINEL: '.gma-media' } });
    t.after(async () => {
      await ctx.cleanup();
      await fsp.rm(dir, { recursive: true, force: true });
    });
    let res = await ctx.app.inject({ method: 'GET', url: '/healthz' });
    assert.equal(res.statusCode, 200);
    assert.equal(res.json().media, true);
    await fsp.rm(path.join(media, '.gma-media'));
    res = await ctx.app.inject({ method: 'GET', url: '/healthz' });
    assert.equal(res.statusCode, 503);
    assert.equal(res.json().media, false);

    const { main } = await import('../scripts/worker-health.js');
    const { setSetting } = await import('../src/lib/settings.js');
    setSetting(ctx.db, 'worker_last_seen', Date.now());
    const errors = [];
    const out = { error: (m) => errors.push(m) };
    const env = { DATA_DIR: ctx.config.dataDir, MEDIA_DIR: media, MEDIA_SENTINEL: '.gma-media' };
    assert.equal(await main([], { env, out }), 1);
    assert.match(errors.join(' '), /photo drive/i);
    await fsp.writeFile(path.join(media, '.gma-media'), '');
    assert.equal(await main([], { env, out }), 0);
  });
});

describe('CI: seed-demo', () => {
  test('sample originals are made in a temp file that keeps the real extension, so ffmpeg knows the format', async () => {
    const { tempOriginalPath } = await import('../scripts/seed-demo.js');
    const { createStorage } = await import('../src/lib/storage.js');
    const storage = createStorage(path.join(os.tmpdir(), 'gma-seed-x'));
    const key = storage.originalKey('01JTESTVIDEO0000000000000A', 'mp4', Date.UTC(2026, 9, 22));
    assert.match(tempOriginalPath(storage, key, 'mp4'), /\.mp4\.tmp-[0-9a-f]+\.mp4$/);
    assert.match(tempOriginalPath(storage, key, 'm4a'), /\.tmp-[0-9a-f]+\.m4a$/);
  });
});

describe('OPS-11: a snapshot before new migrations', async () => {
  const dbmod = await import('../src/db/index.js');

  test('pending migrations on an existing database: a restorable copy lands in backups first, and is kept', async (t) => {
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'gma-premig-'));
    t.after(() => fsp.rm(dir, { recursive: true, force: true }));
    const all = dbmod.listMigrations();
    const older = path.join(dir, 'older');
    await fsp.mkdir(older);
    for (const name of all.slice(0, -1)) await fsp.copyFile(path.join(fileURLToPath(new URL('../src/db/migrations/', import.meta.url)), name), path.join(older, name));
    const dbPath = path.join(dir, 'data', 'gma.sqlite');
    dbmod.openDb(dbPath, { migrationsDir: older }).close();
    const backupsDir = path.join(dir, 'media', 'backups');

    const file = await dbmod.snapshotBeforeMigrations({ dbPath, backupsDir });
    assert.ok(file, 'a snapshot was taken');
    const stem = all.at(-1).replace(/\.sql$/, '');
    assert.match(path.basename(file), new RegExp(`^pre-${stem}-\\d{8}T\\d{6}Z\\.sqlite$`));
    const copy = new Database(file, { readonly: true });
    assert.equal(copy.prepare('SELECT COUNT(*) AS n FROM schema_migrations').get().n, all.length - 1);
    copy.close();

    assert.equal(await dbmod.snapshotBeforeMigrations({ dbPath, backupsDir }), null, 'one per migration');
    dbmod.openDb(dbPath).close(); // now migrated
    const { pruneSnapshots } = await import('../src/jobs/snapshot.js');
    await pruneSnapshots(backupsDir, { keep: 0 });
    assert.ok(fs.existsSync(file), 'the nightly pruning keeps it');
  });

  test('nothing pending, or a brand-new database: no snapshot', async (t) => {
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'gma-premig-'));
    t.after(() => fsp.rm(dir, { recursive: true, force: true }));
    const dbPath = path.join(dir, 'gma.sqlite');
    const backupsDir = path.join(dir, 'backups');
    assert.equal(await dbmod.snapshotBeforeMigrations({ dbPath, backupsDir }), null);
    dbmod.openDb(dbPath).close();
    assert.equal(await dbmod.snapshotBeforeMigrations({ dbPath, backupsDir }), null);
    assert.equal(fs.existsSync(backupsDir), false);
  });
});

describe('F7: short names keep kinship words', async () => {
  const { defaultShortName, shortNameOf } = await import('../src/lib/people.js');

  test('a leading kinship or title word keeps the next word with it', () => {
    assert.equal(defaultShortName('Uncle Mike Torres'), 'Uncle Mike');
    assert.equal(defaultShortName('  aunt   Carol '), 'aunt Carol');
    assert.equal(defaultShortName('Grandpa Joe'), 'Grandpa Joe');
    assert.equal(defaultShortName('Great Aunt Mary'), 'Great Aunt Mary');
    assert.equal(defaultShortName('Sarah Lee'), 'Sarah');
    assert.equal(defaultShortName('Nana'), 'Nana');
    assert.equal(shortNameOf({ name: 'Cousin Jo Smith', short_name: null }), 'Cousin Jo');
  });

  test('the database default follows the same rule, new rows and renames alike, and a chosen name stays', async (t) => {
    const { makeTestApp, makeUser } = await import('./helpers/index.js');
    const ctx = await makeTestApp();
    t.after(ctx.cleanup);
    const shortOf = (id) => ctx.db.prepare('SELECT short_name FROM users WHERE id = ?').get(id).short_name;
    const mike = makeUser(ctx.db, { name: 'Uncle Mike' });
    const sarah = makeUser(ctx.db, { name: 'Sarah Lee' });
    const carol = makeUser(ctx.db, { name: 'Aunt Carol Ruiz' });
    assert.equal(shortOf(mike.id), 'Uncle Mike');
    assert.equal(shortOf(sarah.id), 'Sarah');
    assert.equal(shortOf(carol.id), 'Aunt Carol');
    ctx.db.prepare('UPDATE users SET name = ? WHERE id = ?').run('Grandpa Joe', sarah.id);
    assert.equal(shortOf(sarah.id), 'Grandpa Joe', 'a default follows a rename');
    ctx.db.prepare('UPDATE users SET short_name = ? WHERE id = ?').run('Mikey', mike.id);
    ctx.db.prepare('UPDATE users SET name = ? WHERE id = ?').run('Uncle Michael', mike.id);
    assert.equal(shortOf(mike.id), 'Mikey', 'a chosen name stays');
  });

  test('the migration recomputes defaults nobody edited, and leaves edited ones', async (t) => {
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'gma-f7-'));
    t.after(() => fsp.rm(dir, { recursive: true, force: true }));
    const { listMigrations } = await import('../src/db/index.js');
    const src = fileURLToPath(new URL('../src/db/migrations/', import.meta.url));
    const all = listMigrations();
    const kin = all.find((n) => /kinship/.test(n));
    assert.ok(kin, 'a kinship migration exists');
    const older = path.join(dir, 'older');
    await fsp.mkdir(older);
    for (const name of all.slice(0, all.indexOf(kin))) await fsp.copyFile(path.join(src, name), path.join(older, name));
    const dbPath = path.join(dir, 'gma.sqlite');
    const db = openDb(dbPath, { migrationsDir: older });
    const add = (id, name) => db.prepare("INSERT INTO users (id, name, email, role, status, created_at) VALUES (?, ?, ?, 'member', 'active', 1)").run(id, name, `${id}@example.com`);
    add('u1', 'Uncle Mike');
    add('u2', 'Aunt Carol');
    db.prepare("UPDATE users SET short_name = 'Caz' WHERE id = 'u2'").run();
    add('u3', 'Sarah Lee');
    assert.equal(db.prepare("SELECT short_name FROM users WHERE id = 'u1'").get().short_name, 'Uncle');
    db.close();
    const after = openDb(dbPath);
    const short = (id) => after.prepare('SELECT short_name FROM users WHERE id = ?').get(id).short_name;
    assert.deepEqual([short('u1'), short('u2'), short('u3')], ['Uncle Mike', 'Caz', 'Sarah']);
    after.close();
  });

  test('accepting an invite may say what Grandma calls you (at most 30 letters)', async (t) => {
    const { makeTestApp } = await import('./helpers/index.js');
    const { randomToken, sha256 } = await import('../src/lib/tokens.js');
    const { newId } = await import('../src/lib/ids.js');
    const ctx = await makeTestApp();
    t.after(ctx.cleanup);
    const invite = (email) => {
      const token = randomToken(32);
      const at = Date.now();
      ctx.db.prepare(
        `INSERT INTO invites (id, token_hash, created_by, name, email, role, sent_at, expires_at, used_at, used_by, revoked_at, created_at)
         VALUES (?, ?, NULL, NULL, ?, 'member', NULL, ?, NULL, NULL, NULL, ?)`,
      ).run(newId(), sha256(token), email, at + 86_400_000, at);
      return token;
    };
    const accept = (token, body) => ctx.app.inject({ method: 'POST', url: `/api/invites/${token}/accept`, payload: body });
    const one = invite('mike@example.com');
    let res = await accept(one, { name: 'Michael Torres', email: 'mike@example.com', short_name: '  Uncle   Mikey ' });
    assert.equal(res.statusCode, 200, res.body);
    assert.equal(ctx.db.prepare("SELECT short_name FROM users WHERE email = 'mike@example.com'").get().short_name, 'Uncle Mikey');
    const two = invite('jo@example.com');
    res = await accept(two, { name: 'Jo', email: 'jo@example.com', short_name: 'x'.repeat(31) });
    assert.equal(res.statusCode, 400);
    res = await accept(two, { name: 'Cousin Jo Smith', email: 'jo@example.com' });
    assert.equal(res.statusCode, 200, res.body);
    assert.equal(ctx.db.prepare("SELECT short_name FROM users WHERE email = 'jo@example.com'").get().short_name, 'Cousin Jo');
  });
});

describe('admin health: the upload budget, the free-space floor and the drive', () => {
  test('GET /api/admin/health shows the limits and whether the drive is there', async (t) => {
    const { makeTestApp, makeUser, loginAs } = await import('./helpers/index.js');
    const ctx = await makeTestApp({ routeOptions: { uploadLimits: { minFreeBytes: 1 } } });
    t.after(ctx.cleanup);
    const cookie = loginAs(ctx.app, ctx.db, makeUser(ctx.db, { role: 'admin' }));
    const res = await ctx.app.inject({ method: 'GET', url: '/api/admin/health', headers: { cookie } });
    assert.equal(res.statusCode, 200, res.body);
    const body = res.json();
    assert.deepEqual(body.upload_limits, { files_per_day: 200, bytes_per_day: 10 * 1024 ** 3, min_free_bytes: 1, uploads_per_hour: 120 });
    assert.equal(body.below_free_floor, false);
    assert.equal(body.media_mounted, true);
  });
});
