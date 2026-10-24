import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import sharp from 'sharp';
import { main as createAdmin } from '../scripts/create-admin.js';
import { main as genVapid } from '../scripts/gen-vapid.js';
import { UsageError } from '../scripts/lib/cli.js';
import { main as pairDevice } from '../scripts/pair-device.js';
import { findFfmpeg, main as seedDemo } from '../scripts/seed-demo.js';
import { openDb } from '../src/db/index.js';
import { sha256 } from '../src/lib/tokens.js';
import { makeTempDir, TEST_ORIGIN } from './helpers/index.js';

// Captures what a CLI prints.
function capture() {
  const lines = { out: [], err: [] };
  return {
    lines,
    out: { log: (s = '') => lines.out.push(String(s)), error: (s = '') => lines.err.push(String(s)) },
    text: () => lines.out.join('\n'),
    errors: () => lines.err.join('\n'),
  };
}

async function makeEnv() {
  const tempDir = await makeTempDir('gma-cli-');
  const env = {
    NODE_ENV: 'test',
    PUBLIC_URL: TEST_ORIGIN,
    DATA_DIR: path.join(tempDir, 'data'),
    MEDIA_DIR: path.join(tempDir, 'media'),
    LOG_LEVEL: 'silent',
  };
  return { tempDir, env, open: () => openDb(path.join(env.DATA_DIR, 'gma.sqlite')) };
}

describe('create-admin', () => {
  let ctx;
  before(async () => {
    ctx = await makeEnv();
  });
  after(async () => fs.rm(ctx.tempDir, { recursive: true, force: true }));

  test('creates an active admin, then changes nothing on a second run', async () => {
    const first = capture();
    assert.equal(await createAdmin(['--name', 'Ben Lee', '--email', 'ben@example.com'], { env: ctx.env, out: first.out }), 0);
    assert.match(first.text(), /Added Ben Lee <ben@example.com> as an admin/);
    assert.match(first.text(), /http:\/\/localhost:8080\/signin/);

    const second = capture();
    assert.equal(await createAdmin(['--name', 'Ben', '--email', 'BEN@example.com'], { env: ctx.env, out: second.out }), 0);
    assert.match(second.text(), /already an admin. Nothing changed/);

    const db = ctx.open();
    try {
      const rows = db.prepare('SELECT * FROM users').all();
      assert.equal(rows.length, 1);
      assert.equal(rows[0].role, 'admin');
      assert.equal(rows[0].status, 'active');
      assert.ok(rows[0].activated_at);
      assert.equal(db.prepare("SELECT COUNT(*) AS n FROM admin_log WHERE action = 'cli.admin_create'").get().n, 1);
    } finally {
      db.close();
    }
  });

  test('promotes a member and restores a removed person', async () => {
    const db = ctx.open();
    db.prepare(
      "INSERT INTO users (id, name, email, role, status, created_at) VALUES ('01HZZZZZZZZZZZZZZZZZZZZZZZ', 'Ann', 'ann@example.com', 'member', 'removed', 1)",
    ).run();
    db.close();
    const c = capture();
    assert.equal(await createAdmin(['--name', 'Ann', '--email', 'ann@example.com'], { env: ctx.env, out: c.out }), 0);
    assert.match(c.text(), /Restored Ann/);
    const check = ctx.open();
    const ann = check.prepare("SELECT * FROM users WHERE email = 'ann@example.com'").get();
    check.close();
    assert.equal(ann.role, 'admin');
    assert.equal(ann.status, 'active');
    assert.equal(ann.removed_at, null);
  });

  test('missing or bad flags are usage errors', async () => {
    await assert.rejects(createAdmin(['--email', 'x@example.com'], { env: ctx.env, out: capture().out }), UsageError);
    await assert.rejects(createAdmin(['--name', 'X'], { env: ctx.env, out: capture().out }), UsageError);
    await assert.rejects(createAdmin(['--name', 'X', '--email', 'nope'], { env: ctx.env, out: capture().out }), UsageError);
    await assert.rejects(createAdmin(['--bogus'], { env: ctx.env, out: capture().out }), UsageError);
  });

  test('a production config without secrets fails with a readable ConfigError', async () => {
    await assert.rejects(
      createAdmin(['--name', 'X', '--email', 'x@example.com'], { env: { NODE_ENV: 'production' }, out: capture().out }),
      (err) => err.name === 'ConfigError' && /PUBLIC_URL/.test(err.message),
    );
  });
});

describe('pair-device', () => {
  let ctx;
  before(async () => {
    ctx = await makeEnv();
  });
  after(async () => fs.rm(ctx.tempDir, { recursive: true, force: true }));

  test('prints the pairing link once and stores only its hash', async () => {
    const c = capture();
    assert.equal(await pairDevice(['--name', 'Kitchen frame'], { env: ctx.env, out: c.out }), 0);
    const url = c.text().match(/(http:\/\/localhost:8080\/grandma\?device=\S+)/)?.[1];
    assert.ok(url, c.text());
    const token = decodeURIComponent(new URL(url).searchParams.get('device'));
    const db = ctx.open();
    try {
      const device = db.prepare('SELECT * FROM devices').get();
      assert.equal(device.name, 'Kitchen frame');
      assert.equal(device.created_by, null);
      assert.equal(device.token_hash, sha256(token));
      const logged = db.prepare("SELECT detail FROM admin_log WHERE action = 'cli.device_pair'").get();
      assert.ok(!logged.detail.includes(token));
    } finally {
      db.close();
    }
  });

  test('defaults the name', async () => {
    assert.equal(await pairDevice([], { env: ctx.env, out: capture().out }), 0);
    const db = ctx.open();
    const names = db.prepare('SELECT name FROM devices').all().map((d) => d.name);
    db.close();
    assert.ok(names.includes("Grandma's frame"));
  });
});

describe('gen-vapid', () => {
  test('prints a valid key pair as env lines, notes on stderr', async () => {
    const c = capture();
    assert.equal(await genVapid(['--subject', 'mailto:ben@example.com'], { env: {}, out: c.out }), 0);
    const [pub, priv, subject] = c.lines.out;
    assert.match(pub, /^VAPID_PUBLIC_KEY=[A-Za-z0-9_-]{87}$/);
    assert.match(priv, /^VAPID_PRIVATE_KEY=[A-Za-z0-9_-]{43}$/);
    assert.equal(subject, 'VAPID_SUBJECT=mailto:ben@example.com');
    assert.ok(c.lines.err.every((line) => line.startsWith('#')));
  });

  test('refuses to rotate keys that are already set unless forced', async () => {
    const c = capture();
    assert.equal(await genVapid([], { env: { VAPID_PUBLIC_KEY: 'x' }, out: c.out }), 1);
    assert.equal(c.lines.out.length, 0);
    assert.match(c.errors(), /already set/);
    assert.equal(await genVapid(['--force'], { env: { VAPID_PUBLIC_KEY: 'x' }, out: capture().out }), 0);
  });

  test('asks for a real subject when none is given and rejects a bad one', async () => {
    const c = capture();
    assert.equal(await genVapid([], { env: {}, out: c.out }), 0);
    assert.equal(c.lines.out.length, 2);
    assert.match(c.errors(), /VAPID_SUBJECT=mailto:/);
    await assert.rejects(genVapid(['--subject', 'ben@example.com'], { env: {}, out: capture().out }), UsageError);
  });
});

describe('seed-demo', () => {
  let ctx;
  let photosDir;
  before(async () => {
    ctx = await makeEnv();
    photosDir = path.join(ctx.tempDir, 'photos');
    await fs.mkdir(photosDir);
    for (const [i, colour] of ['#C9A27E', '#8FA58A', '#B8862B'].entries()) {
      await sharp({ create: { width: 64, height: 48, channels: 3, background: colour } })
        .jpeg()
        .toFile(path.join(photosDir, `p${i}.jpg`));
    }
  });
  after(async () => fs.rm(ctx.tempDir, { recursive: true, force: true }));

  test('does nothing without --yes', async () => {
    const c = capture();
    assert.equal(await seedDemo(['--photos', photosDir], { env: ctx.env, out: c.out, ffmpeg: null }), 1);
    assert.match(c.errors(), /--yes/);
    const db = ctx.open();
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM users').get().n, 0);
    db.close();
  });

  test('refuses a production config unless --allow-production', async () => {
    const env = { ...ctx.env, NODE_ENV: 'production', SECRET_KEY: Buffer.alloc(32, 7).toString('base64') };
    const c = capture();
    assert.equal(await seedDemo(['--yes'], { env, out: c.out, ffmpeg: null }), 1);
    assert.match(c.errors(), /--allow-production/);
  });

  test('seeds a demo family, queued photo jobs, a frame and Grandma’s answers', async () => {
    const c = capture();
    assert.equal(await seedDemo(['--yes', '--photos', photosDir], { env: ctx.env, out: c.out, ffmpeg: null }), 0);
    assert.match(c.text(), /http:\/\/localhost:8080\/grandma\?device=\S+/);
    assert.match(c.text(), /no videos/);

    const db = ctx.open();
    try {
      const users = db.prepare('SELECT * FROM users').all();
      assert.ok(users.length >= 6);
      assert.ok(users.every((u) => u.email.endsWith('@demo.invalid')));
      assert.ok(users.some((u) => u.role === 'admin' && u.status === 'active'));

      const items = db.prepare('SELECT * FROM items').all();
      assert.ok(items.length >= 10);
      assert.ok(items.every((i) => i.status === 'processing' && i.kind === 'photo'));
      const mediaDir = ctx.env.MEDIA_DIR;
      for (const item of items) {
        assert.match(item.original_path, /^originals\/\d{4}\/\d{2}\/[0-9A-Z]{26}\.jpg$/);
        const stat = await fs.stat(path.join(mediaDir, item.original_path));
        assert.equal(stat.size, item.original_bytes);
      }
      const batches = db.prepare('SELECT batch_id, COUNT(*) AS n FROM items GROUP BY batch_id').all();
      assert.ok(batches.some((b) => b.n >= 3), 'posts with several photos share a batch');

      const jobs = db.prepare("SELECT * FROM jobs WHERE status = 'queued'").all();
      assert.equal(jobs.length, items.length);
      assert.ok(jobs.every((j) => j.kind === 'image'));

      const devices = db.prepare('SELECT * FROM devices').all();
      assert.deepEqual(devices.map((d) => d.name), ['Demo frame']);

      const events = db.prepare('SELECT * FROM grandma_events').all();
      assert.ok(events.length >= 4);
      assert.ok(events.every((e) => e.device_id === devices[0].id && e.recipient_user_id && e.created_at <= Date.now()));
      assert.ok(events.some((e) => e.kind === 'preset' && e.preset_id && e.preset_text));

      const logged = db.prepare("SELECT detail FROM admin_log WHERE action = 'cli.seed_demo'").get();
      assert.ok(!logged.detail.includes('device='), 'the frame link is never logged');
    } finally {
      db.close();
    }
  });

  test('a second run sees the demo data and adds nothing', async () => {
    const db = ctx.open();
    const before = db.prepare('SELECT COUNT(*) AS n FROM items').get().n;
    db.close();
    const c = capture();
    assert.equal(await seedDemo(['--yes', '--photos', photosDir], { env: ctx.env, out: c.out, ffmpeg: null }), 1);
    assert.match(c.errors(), /already here/);
    const again = ctx.open();
    assert.equal(again.prepare('SELECT COUNT(*) AS n FROM items').get().n, before);
    again.close();
  });

  test('never runs on a database with real family members', async () => {
    const fresh = await makeEnv();
    try {
      const db = fresh.open();
      db.prepare(
        "INSERT INTO users (id, name, email, role, status, created_at) VALUES ('01HZZZZZZZZZZZZZZZZZZZZZZZ', 'Grandpa', 'real@example.com', 'member', 'active', 1)",
      ).run();
      db.close();
      const c = capture();
      assert.equal(await seedDemo(['--yes', '--photos', photosDir], { env: fresh.env, out: c.out, ffmpeg: null }), 1);
      assert.match(c.errors(), /real family members/);
      const check = fresh.open();
      assert.equal(check.prepare('SELECT COUNT(*) AS n FROM items').get().n, 0);
      assert.equal(check.prepare('SELECT COUNT(*) AS n FROM devices').get().n, 0);
      check.close();
    } finally {
      await fs.rm(fresh.tempDir, { recursive: true, force: true });
    }
  });

  test('falls back to plain pictures when there are no sample photos', async () => {
    const fresh = await makeEnv();
    try {
      const c = capture();
      const empty = path.join(fresh.tempDir, 'none');
      assert.equal(await seedDemo(['--yes', '--photos', empty], { env: fresh.env, out: c.out, ffmpeg: null }), 0);
      assert.match(c.text(), /plain coloured pictures/);
      const db = fresh.open();
      assert.ok(db.prepare('SELECT COUNT(*) AS n FROM items').get().n >= 10);
      db.close();
    } finally {
      await fs.rm(fresh.tempDir, { recursive: true, force: true });
    }
  });

  test('makes sample videos and a voice message when ffmpeg is installed', { skip: !findFfmpeg() && 'ffmpeg is not installed' }, async () => {
    const fresh = await makeEnv();
    try {
      const c = capture();
      assert.equal(await seedDemo(['--yes', '--photos', photosDir], { env: fresh.env, out: c.out, ffmpeg: 'ffmpeg' }), 0);
      const db = fresh.open();
      assert.ok(db.prepare("SELECT COUNT(*) AS n FROM items WHERE kind = 'video'").get().n >= 1);
      assert.ok(db.prepare("SELECT COUNT(*) AS n FROM jobs WHERE kind = 'voice'").get().n >= 1);
      db.close();
    } finally {
      await fs.rm(fresh.tempDir, { recursive: true, force: true });
    }
  });
});

describe('worker-health', () => {
  test('healthy only when the worker checked in within a minute', async () => {
    const { main: workerHealth } = await import('../scripts/worker-health.js');
    const ctx = await makeEnv();
    try {
      const quiet = { log() {}, error() {} };
      assert.equal(await workerHealth([], { env: ctx.env, out: quiet }), 1, 'no database yet');
      const db = ctx.open();
      assert.equal(await workerHealth([], { env: ctx.env, out: quiet }), 1, 'never checked in');
      db.prepare("INSERT INTO settings (key, value) VALUES ('worker_last_seen', ?)").run(JSON.stringify(Date.now() - 10_000));
      assert.equal(await workerHealth([], { env: ctx.env, out: quiet }), 0);
      assert.equal(await workerHealth([], { env: ctx.env, out: quiet, now: Date.now() + 120_000 }), 1, 'stale');
      db.close();
    } finally {
      await fs.rm(ctx.tempDir, { recursive: true, force: true });
    }
  });
});
