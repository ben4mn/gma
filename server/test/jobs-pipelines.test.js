import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { makeTestApp, makeUser, makeDevice } from './helpers/index.js';
import { LANDSCAPE_JPG, makeJpeg, makePng } from './fixtures/images.js';
import { newId } from '../src/lib/ids.js';
import { eventsAfter, latestEventId } from '../src/lib/events.js';
import { MAX_INPUT_PIXELS, MediaToolError, createMediaTools, heifDeclaredPixels, orientedSize, renderStill } from '../src/lib/media.js';
import { setSetting } from '../src/lib/settings.js';
import { enqueue, claim } from '../src/jobs/queue.js';
import { startRunner } from '../src/jobs/runner.js';
import * as imageJob from '../src/jobs/image.js';
import { TOO_BIG_MESSAGE } from '../src/jobs/image.js';
import * as videoJob from '../src/jobs/video.js';
import * as voiceJob from '../src/jobs/voice.js';

// A stand-in for the spawn wrapper: answers ffprobe from `probes` (by path
// substring) and makes ffmpeg/heif-dec write plausible output files.
function fakeExec(probes = {}) {
  const calls = [];
  async function run(file, args) {
    const tool = file.split('/').pop();
    calls.push({ tool, args });
    if (tool === 'ffprobe') {
      const input = args.at(-1);
      const match = Object.keys(probes).find((k) => input.includes(k)) ?? 'default';
      return { stdout: JSON.stringify(probes[match]), stderr: '' };
    }
    const output = tool === 'heif-dec' ? args[1] : args.at(-1);
    const isStill = tool === 'heif-dec' || args.includes('png');
    await fs.writeFile(output, isStill ? await makePng({ width: 1920, height: 1080 }) : Buffer.from(`${tool} output`));
    return { stdout: '', stderr: '' };
  }
  return { run, calls };
}

const probe = ({ seconds = 12.5, width = 1920, height = 1080, rotation, transfer = 'bt709', audio = true } = {}) => ({
  format: { duration: String(seconds) },
  streams: [
    {
      codec_type: 'video',
      width,
      height,
      color_transfer: transfer,
      ...(rotation !== undefined ? { side_data_list: [{ side_data_type: 'Display Matrix', rotation }] } : {}),
    },
    ...(audio ? [{ codec_type: 'audio' }] : []),
  ],
});

async function addItem(ctx, { kind = 'photo', mime = 'image/jpeg', ext = 'jpg', bytes }) {
  const user = makeUser(ctx.db);
  const id = newId();
  const key = ctx.app.storage.originalKey(id, ext);
  await fs.writeFile(await ctx.app.storage.ensureDirFor(key), bytes);
  ctx.db
    .prepare(`INSERT INTO items (id, user_id, kind, status, original_path, original_mime, created_at) VALUES (?, ?, ?, 'processing', ?, ?, ?)`)
    .run(id, user.id, kind, key, mime, Date.now());
  return { id, user };
}

function jobCtx(ctx, media = createMediaTools(), extra = {}) {
  return { config: ctx.config, db: ctx.db, storage: ctx.app.storage, media, log: undefined, signal: new AbortController().signal, ...extra };
}

const renditions = (ctx, id) =>
  Object.fromEntries(ctx.db.prepare('SELECT * FROM renditions WHERE item_id = ?').all(id).map((r) => [r.name, r]));

test('a phone JPEG becomes thumb/display/large, upright, without EXIF or GPS, and goes live', async (t) => {
  const ctx = await makeTestApp();
  t.after(ctx.cleanup);
  // 3000x2000 stored sideways (orientation 6): upright it is 2000x3000.
  const { id, user } = await addItem(ctx, { bytes: await makeJpeg({ width: 3000, height: 2000, orientation: 6 }) });
  const before = latestEventId(ctx.db);

  await imageJob.run(jobCtx(ctx), { ref_id: id });

  const item = ctx.db.prepare('SELECT * FROM items WHERE id = ?').get(id);
  assert.equal(item.status, 'ready');
  assert.equal(item.width, 2000);
  assert.equal(item.height, 3000);
  assert.ok(item.ready_at);

  const r = renditions(ctx, id);
  assert.deepEqual(Object.keys(r).sort(), ['display', 'large', 'thumb']);
  const expect = { thumb: [320, 480, 'webp'], display: [1067, 1600, 'jpeg'], large: [1707, 2560, 'jpeg'] };
  for (const [name, [w, h, format]] of Object.entries(expect)) {
    const file = ctx.app.storage.resolve(r[name].path);
    const meta = await sharp(file).metadata();
    assert.equal(meta.format, format, name);
    assert.deepEqual([meta.width, meta.height], [w, h], `${name} is fit inside its size and upright`);
    assert.deepEqual([r[name].width, r[name].height], [w, h]);
    assert.equal(meta.exif, undefined, `${name} carries no EXIF (so no GPS)`);
    assert.ok([undefined, 1].includes(meta.orientation));
    assert.equal(r[name].bytes, (await fs.stat(file)).size);
  }
  assert.match(r.thumb.path, new RegExp(`^renditions/${id}/thumb\\.webp$`));

  const events = eventsAfter(ctx.db, before);
  assert.equal(events.length, 1);
  assert.equal(events[0].topic, 'item.ready');
  assert.equal(events[0].audience, 'all');
  assert.deepEqual(events[0].payload, { item_id: id, user_id: user.id, kind: 'photo', batch_id: null });
});

test('small photos are never enlarged; PNG and a real sample photo work', async (t) => {
  const ctx = await makeTestApp();
  t.after(ctx.cleanup);
  const png = await addItem(ctx, { mime: 'image/png', ext: 'png', bytes: await makePng({ width: 300, height: 300 }) });
  await imageJob.run(jobCtx(ctx), { ref_id: png.id });
  for (const r of Object.values(renditions(ctx, png.id))) assert.deepEqual([r.width, r.height], [300, 300]);

  const real = await addItem(ctx, { bytes: await fs.readFile(LANDSCAPE_JPG) });
  await imageJob.run(jobCtx(ctx), { ref_id: real.id });
  const r = renditions(ctx, real.id);
  assert.deepEqual([r.display.width, r.display.height], [1600, 589]);
  assert.deepEqual([r.thumb.width, r.thumb.height], [480, 176]);
});

test('HEIC goes through heif-dec first', async (t) => {
  const ctx = await makeTestApp();
  t.after(ctx.cleanup);
  const exec = fakeExec();
  const { id } = await addItem(ctx, { mime: 'image/heic', ext: 'heic', bytes: Buffer.from('not really heic') });
  await imageJob.run(jobCtx(ctx, createMediaTools({ exec: exec.run, which: (n) => `/fake/${n}` })), { ref_id: id });
  assert.equal(exec.calls[0].tool, 'heif-dec');
  const { original_path: originalPath } = ctx.db.prepare('SELECT original_path FROM items WHERE id = ?').get(id);
  assert.equal(exec.calls[0].args[0], ctx.app.storage.resolve(originalPath));
  assert.match(exec.calls[0].args[1], /decoded\.png$/);
  assert.equal(ctx.db.prepare('SELECT status FROM items WHERE id = ?').get(id).status, 'ready');
  assert.equal(renditions(ctx, id).display.width, 1600);
});

// A HEIF `ispe` box (image spatial extents): size, type, version/flags, width, height.
function ispe(width, height) {
  const box = Buffer.alloc(20);
  box.writeUInt32BE(20, 0);
  box.write('ispe', 4, 'latin1');
  box.writeUInt32BE(width, 12);
  box.writeUInt32BE(height, 16);
  return box;
}

test('a HEIC that declares a giant image is refused before heif-dec decodes it (SEC-5)', async (t) => {
  const ctx = await makeTestApp();
  t.after(ctx.cleanup);
  assert.equal(heifDeclaredPixels(Buffer.concat([Buffer.from('ftypheic'), ispe(512, 512), ispe(8064, 6048)])), 8064 * 6048);
  assert.equal(heifDeclaredPixels(Buffer.from('no boxes here')), null);

  const exec = fakeExec();
  const bomb = Buffer.concat([Buffer.from('....ftypheic....meta'), ispe(40000, 40000)]);
  const { id } = await addItem(ctx, { mime: 'image/heic', ext: 'heic', bytes: bomb });
  const media = createMediaTools({ exec: exec.run, which: (n) => `/fake/${n}` });
  await assert.rejects(imageJob.run(jobCtx(ctx, media), { ref_id: id }), (err) => err.permanent && err.userMessage === TOO_BIG_MESSAGE);
  assert.ok(!exec.calls.some((c) => c.tool === 'heif-dec'), 'never decoded');

  // A 48 MP iPhone photo is fine.
  const phone = await addItem(ctx, { mime: 'image/heic', ext: 'heic', bytes: Buffer.concat([Buffer.from('ftypheic'), ispe(8064, 6048)]) });
  await imageJob.run(jobCtx(ctx, media), { ref_id: phone.id });
  assert.equal(ctx.db.prepare('SELECT status FROM items WHERE id = ?').get(phone.id).status, 'ready');
});

test('sharp refuses images over the pixel cap (SEC-5)', async () => {
  assert.equal(MAX_INPUT_PIXELS, 120_000_000);
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'gma-pixels-'));
  try {
    // 11000 × 11000 = 121 MP of one colour: tiny as a PNG, huge decoded.
    const big = path.join(dir, 'big.png');
    await sharp({ create: { width: 11000, height: 11000, channels: 3, background: '#fff' } }).png().toFile(big);
    await assert.rejects(orientedSize(big), /pixel limit/i);
    await assert.rejects(renderStill(big, { size: 480, format: 'webp', quality: 72 }, path.join(dir, 'out.webp')), /pixel limit/i);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('an unreadable photo fails for good with a kind message for its owner', async (t) => {
  const ctx = await makeTestApp();
  t.after(ctx.cleanup);
  const { id, user } = await addItem(ctx, { bytes: Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.from('garbage')]) });
  enqueue(ctx.db, { kind: 'image', refId: id });
  const before = latestEventId(ctx.db);
  const runner = startRunner({ config: ctx.config, db: ctx.db, storage: ctx.app.storage, pollMs: 60_000 });
  runner.tick();
  await runner.drain();
  await runner.stop();

  const item = ctx.db.prepare('SELECT * FROM items WHERE id = ?').get(id);
  assert.equal(item.status, 'failed');
  assert.match(item.error, /couldn't open this photo/);
  assert.equal(ctx.db.prepare('SELECT status, attempts FROM jobs WHERE ref_id = ?').get(id).status, 'failed');
  const [event] = eventsAfter(ctx.db, before);
  assert.equal(event.topic, 'item.failed');
  assert.equal(event.audience, `user:${user.id}`);
  assert.equal(event.payload.error, item.error);
});

test('an item deleted mid-processing does not come back', async (t) => {
  const ctx = await makeTestApp();
  t.after(ctx.cleanup);
  const { id } = await addItem(ctx, { bytes: await makeJpeg() });
  const media = createMediaTools();
  const c = jobCtx(ctx, media);
  // Delete the row right after the job read it: finishItem must notice.
  const original = c.db;
  let reads = 0;
  c.db = new Proxy(original, {
    get(target, prop) {
      if (prop === 'transaction' && reads++ === 0) original.prepare('DELETE FROM items WHERE id = ?').run(id);
      const v = target[prop];
      return typeof v === 'function' ? v.bind(target) : v;
    },
  });
  await imageJob.run(c, { ref_id: id });
  assert.equal(ctx.db.prepare('SELECT COUNT(*) AS n FROM items').get().n, 0);
  await assert.rejects(fs.access(ctx.app.storage.resolve(`renditions/${id}`)));
});

test('a video is transcoded with the contract\'s settings, gets a poster and thumb, and goes live', async (t) => {
  const ctx = await makeTestApp();
  t.after(ctx.cleanup);
  const exec = fakeExec({ originals: probe({ seconds: 42.25, width: 1920, height: 1080, rotation: -90 }), renditions: probe({ width: 406, height: 720 }) });
  const { id } = await addItem(ctx, { kind: 'video', mime: 'video/quicktime', ext: 'mov', bytes: Buffer.from('mov') });
  await videoJob.run(jobCtx(ctx, createMediaTools({ exec: exec.run, which: (n) => `/fake/${n}` })), { ref_id: id });

  const item = ctx.db.prepare('SELECT * FROM items WHERE id = ?').get(id);
  assert.equal(item.status, 'ready');
  assert.equal(item.duration_ms, 42250);
  assert.deepEqual([item.width, item.height], [1080, 1920], 'rotation swaps the displayed size');

  const r = renditions(ctx, id);
  assert.deepEqual(Object.keys(r).sort(), ['poster', 'thumb', 'video']);
  assert.equal(r.video.mime, 'video/mp4');
  assert.deepEqual([r.video.width, r.video.height], [406, 720]);
  assert.match(r.video.path, /video\.mp4$/);
  assert.deepEqual([r.poster.width, r.poster.height, r.poster.mime], [1600, 900, 'image/jpeg']);
  assert.deepEqual([r.thumb.width, r.thumb.height, r.thumb.mime], [480, 270, 'image/webp']);

  const transcode = exec.calls.find((c) => c.tool === 'ffmpeg' && c.args.includes('libx264'));
  const vf = transcode.args[transcode.args.indexOf('-vf') + 1];
  assert.equal(vf, "scale=w='if(gte(iw,ih),-2,min(720,trunc(iw/2)*2))':h='if(gte(iw,ih),min(720,trunc(ih/2)*2),-2)',format=yuv420p", 'SDR: no tone map');
  assert.equal(transcode.args[transcode.args.indexOf('libx264') + 1], '-threads', 'the encoder is capped');
  for (const flag of ['-map_metadata', '-movflags', '+faststart', 'aac', '128k']) assert.ok(transcode.args.includes(flag), flag);
  assert.equal(transcode.args[transcode.args.indexOf('-t') + 1], '181', 'never more than the limit plus a second');
  const poster = exec.calls.find((c) => c.tool === 'ffmpeg' && c.args.includes('png'));
  assert.equal(poster.args[poster.args.indexOf('-ss') + 1], '1');
});

test('HDR video is tone-mapped, and a sub-second clip takes its poster at 0 s', async (t) => {
  const ctx = await makeTestApp();
  t.after(ctx.cleanup);
  const exec = fakeExec({ originals: probe({ seconds: 0.6, transfer: 'arib-std-b67' }), renditions: probe() });
  const { id } = await addItem(ctx, { kind: 'video', mime: 'video/quicktime', ext: 'mov', bytes: Buffer.from('mov') });
  await videoJob.run(jobCtx(ctx, createMediaTools({ exec: exec.run, which: (n) => `/fake/${n}` })), { ref_id: id });
  const transcode = exec.calls.find((c) => c.args.includes('libx264'));
  // Scaled first (OPS-1): the float tone map runs on 720p frames.
  assert.match(transcode.args[transcode.args.indexOf('-vf') + 1], /^scale=w=.*,zscale=t=linear.*tonemap=tonemap=hable.*,format=yuv420p$/);
  const poster = exec.calls.find((c) => c.args.includes('png'));
  assert.equal(poster.args[poster.args.indexOf('-ss') + 1], '0');
  assert.match(poster.args[poster.args.indexOf('-vf') + 1], /tonemap/);
});

test('a video over the limit fails at once with a kind message (the admin setting can lower it)', async (t) => {
  const ctx = await makeTestApp();
  t.after(ctx.cleanup);
  const exec = fakeExec({ default: probe({ seconds: 240 }) });
  const { id } = await addItem(ctx, { kind: 'video', mime: 'video/mp4', ext: 'mp4', bytes: Buffer.from('mp4') });
  enqueue(ctx.db, { kind: 'video', refId: id });
  const runner = startRunner({
    config: ctx.config,
    db: ctx.db,
    storage: ctx.app.storage,
    media: createMediaTools({ exec: exec.run, which: (n) => `/fake/${n}` }),
    pollMs: 60_000,
  });
  runner.tick();
  await runner.drain();
  await runner.stop();
  const item = ctx.db.prepare('SELECT * FROM items WHERE id = ?').get(id);
  assert.equal(item.status, 'failed');
  assert.equal(item.error, 'This video is 4 minutes long, and videos can be up to 3 minutes. Please trim it and send it again.');
  assert.equal(ctx.db.prepare('SELECT attempts, status FROM jobs WHERE ref_id = ?').get(id).attempts, 1, 'no retries');
  assert.ok(!exec.calls.some((c) => c.args.includes('libx264')), 'never transcoded');

  setSetting(ctx.db, 'max_video_seconds', 90);
  assert.equal(videoJob.maxVideoSeconds(ctx.db, ctx.config), 90);
  setSetting(ctx.db, 'max_video_seconds', 9999);
  assert.equal(videoJob.maxVideoSeconds(ctx.db, ctx.config), 180, 'MAX_VIDEO_SECONDS stays the ceiling');
});

test('without ffmpeg the video job fails clearly and retries (it may be installed by then)', async (t) => {
  const ctx = await makeTestApp();
  t.after(ctx.cleanup);
  const { id } = await addItem(ctx, { kind: 'video', mime: 'video/mp4', ext: 'mp4', bytes: Buffer.from('mp4') });
  const jobId = enqueue(ctx.db, { kind: 'video', refId: id });
  const runner = startRunner({ config: ctx.config, db: ctx.db, storage: ctx.app.storage, media: createMediaTools({ which: () => null }), pollMs: 60_000 });
  runner.tick();
  await runner.drain();
  await runner.stop();
  const row = ctx.db.prepare('SELECT * FROM jobs WHERE id = ?').get(jobId);
  assert.equal(row.status, 'queued');
  assert.match(row.error, /ffprobe is not installed/);
  assert.equal(ctx.db.prepare('SELECT status FROM items WHERE id = ?').get(id).status, 'processing');
});

async function addVoiceNote(ctx, { device = makeDevice(ctx.db), userId = null, itemId = null, clientId = newId() } = {}) {
  const id = newId();
  const key = ctx.app.storage.originalKey(id, 'webm');
  await fs.writeFile(await ctx.app.storage.ensureDirFor(key), 'webm');
  ctx.db
    .prepare(
      `INSERT INTO voice_notes (id, device_id, user_id, item_id, status, original_path, client_id, created_at)
       VALUES (?, ?, ?, ?, 'processing', ?, ?, ?)`,
    )
    .run(id, device?.id ?? null, userId, itemId, key, clientId, Date.now());
  return { id, device, clientId };
}

test('Grandma\'s voice note becomes an m4a, a feed event for everyone, a live event and a push, once', async (t) => {
  const ctx = await makeTestApp();
  t.after(ctx.cleanup);
  const exec = fakeExec({ default: probe({ seconds: 42.4 }) });
  const note = await addVoiceNote(ctx);
  const pushes = [];
  const push = { notifyGrandmaEvent: async (db, config, eventId) => pushes.push(eventId) };
  const c = jobCtx(ctx, createMediaTools({ exec: exec.run, which: (n) => `/fake/${n}` }), { push });
  const before = latestEventId(ctx.db);

  await voiceJob.run(c, { ref_id: note.id });

  const row = ctx.db.prepare('SELECT * FROM voice_notes WHERE id = ?').get(note.id);
  assert.equal(row.status, 'ready');
  assert.equal(row.audio_path, `renditions/${note.id}/audio.m4a`);
  assert.equal(row.duration_ms, 42400);
  await fs.access(ctx.app.storage.resolve(row.audio_path));
  const args = exec.calls.find((x) => x.tool === 'ffmpeg').args;
  for (const flag of ['-t', '65', '-ac', '1', '64k', '-map_metadata']) assert.ok(args.includes(flag), flag);

  const event = ctx.db.prepare('SELECT * FROM grandma_events WHERE voice_note_id = ?').get(note.id);
  assert.equal(event.kind, 'voice');
  assert.equal(event.device_id, note.device.id);
  assert.equal(event.recipient_user_id, null);
  assert.equal(event.client_id, note.clientId);
  const live = eventsAfter(ctx.db, before);
  assert.deepEqual(live.map((e) => [e.topic, e.audience, e.payload.id]), [['grandma.event', 'all', event.id]]);
  assert.deepEqual(pushes, [event.id]);

  await voiceJob.run(c, { ref_id: note.id }); // a retry after a crash
  assert.equal(ctx.db.prepare('SELECT COUNT(*) AS n FROM grandma_events').get().n, 1);
  assert.deepEqual(pushes, [event.id], 'no second push');
});

test('a failing push does not fail the voice job; a family note on an upload makes no Grandma event', async (t) => {
  const ctx = await makeTestApp();
  t.after(ctx.cleanup);
  const media = createMediaTools({ exec: fakeExec({ default: probe({ seconds: 3 }) }).run, which: (n) => `/fake/${n}` });
  const note = await addVoiceNote(ctx);
  const push = { notifyGrandmaEvent: async () => { throw new Error('push service down'); } };
  await voiceJob.run(jobCtx(ctx, media, { push, log: { warn() {}, info() {}, error() {} } }), { ref_id: note.id });
  assert.equal(ctx.db.prepare('SELECT status FROM voice_notes WHERE id = ?').get(note.id).status, 'ready');

  const user = makeUser(ctx.db);
  const family = await addVoiceNote(ctx, { device: null, userId: user.id });
  await voiceJob.run(jobCtx(ctx, media, { push }), { ref_id: family.id });
  assert.equal(ctx.db.prepare('SELECT status FROM voice_notes WHERE id = ?').get(family.id).status, 'ready');
  assert.equal(ctx.db.prepare('SELECT COUNT(*) AS n FROM grandma_events WHERE voice_note_id = ?').get(family.id).n, 0);
});

test('the voice job works without lib/push.js and marks a hopeless note failed', async (t) => {
  const ctx = await makeTestApp();
  t.after(ctx.cleanup);
  const media = createMediaTools({ exec: fakeExec({ default: probe({ seconds: 3 }) }).run, which: (n) => `/fake/${n}` });
  const note = await addVoiceNote(ctx);
  await voiceJob.run(jobCtx(ctx, media), { ref_id: note.id }); // loads lib/push.js if the frame area wrote it
  assert.equal(ctx.db.prepare('SELECT COUNT(*) AS n FROM grandma_events').get().n, 1);

  const bad = await addVoiceNote(ctx);
  voiceJob.onFailed({ db: ctx.db }, { ref_id: bad.id });
  assert.equal(ctx.db.prepare('SELECT status FROM voice_notes WHERE id = ?').get(bad.id).status, 'failed');
});

// SEC-4: a video whose length the container doesn't say is measured after a
// capped transcode, and a transcode that runs out of time doesn't retry.
async function runVideo(ctx, run) {
  const { id } = await addItem(ctx, { kind: 'video', mime: 'video/webm', ext: 'webm', bytes: Buffer.from('webm') });
  enqueue(ctx.db, { kind: 'video', refId: id });
  const runner = startRunner({
    config: ctx.config,
    db: ctx.db,
    storage: ctx.app.storage,
    media: createMediaTools({ exec: run, which: (n) => `/fake/${n}` }),
    pollMs: 60_000,
  });
  runner.tick();
  await runner.drain();
  await runner.stop();
  return {
    item: ctx.db.prepare('SELECT * FROM items WHERE id = ?').get(id),
    job: ctx.db.prepare('SELECT attempts, status FROM jobs WHERE ref_id = ?').get(id),
  };
}

const noDuration = () => {
  const p = probe();
  delete p.format.duration;
  return p;
};

test('a video with no duration up front is measured after the capped transcode (SEC-4)', async (t) => {
  const ctx = await makeTestApp();
  t.after(ctx.cleanup);
  const long = fakeExec({ originals: noDuration(), renditions: probe({ seconds: 181 }) });
  const { item, job } = await runVideo(ctx, long.run);
  assert.equal(item.status, 'failed');
  assert.equal(item.error, 'This video is longer than 3 minutes. Please trim it and send it again.');
  assert.equal(job.attempts, 1, 'no retries');
  const transcode = long.calls.find((c) => c.args.includes('libx264'));
  assert.equal(transcode.args[transcode.args.indexOf('-t') + 1], '181');

  const short = fakeExec({ originals: noDuration(), renditions: probe({ seconds: 20 }) });
  const ok = await runVideo(ctx, short.run);
  assert.equal(ok.item.status, 'ready');
  assert.equal(ok.item.duration_ms, 20000, 'the measured length is kept');
});

test('a transcode that runs out of time fails for good instead of retrying (SEC-4)', async (t) => {
  const ctx = await makeTestApp();
  t.after(ctx.cleanup);
  const exec = fakeExec({ default: probe({ seconds: 30 }) });
  const slow = async (file, args, opts) => {
    if (args.includes('libx264')) {
      assert.ok(opts.timeoutMs <= 30 * 60_000 && opts.timeoutMs >= 5 * 60_000, 'a bounded time limit');
      throw new MediaToolError('ffmpeg took longer than 720 s', { tool: 'ffmpeg', timedOut: true });
    }
    return exec.run(file, args, opts);
  };
  const { item, job } = await runVideo(ctx, slow);
  assert.equal(item.status, 'failed');
  assert.equal(item.error, 'This video took too long to get ready. Please trim it and send it again.');
  assert.equal(job.attempts, 1);
});
