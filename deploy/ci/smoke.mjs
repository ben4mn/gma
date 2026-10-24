// The media smoke test. Runs inside the gma:ci image (deploy/ci-on-server.sh):
//
//   node /ci/smoke.mjs --fixtures /work/fixtures --out /work/smoke
//
// It makes a throwaway database and media folder under --out, adds a family
// member, two photos (an iPhone-style HEIC and a JPEG, both carrying GPS), two
// videos (a 10 s 1080x1920 portrait H.264 clip and a 5 s 3840x2160 HEVC 10-bit
// HLG clip, both tagged with a location and a creation time) and a WebM/Opus
// voice note, queues their jobs, starts the real worker (node src/worker.js)
// on them and waits. Then it checks every rendition with ffprobe and sharp
// against docs/ARCHITECTURE.md ("Media pipeline") and prints how long each job
// took, the 4K HDR video above all. Exit 0 only when everything passes.

import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { parseArgs } from 'node:util';
import {
  checkFaststart,
  checkStill,
  checkStillMetadata,
  checkVideoRendition,
  checkVoiceRendition,
  exifHasGps,
  formatSeconds,
  summarise,
} from './smoke-lib.mjs';

const SERVER = process.env.GMA_SERVER_DIR ?? '/app/server';
const requireFromServer = createRequire(path.join(SERVER, 'package.json'));
const sharp = requireFromServer('sharp');
const { openDb } = await import(path.join(SERVER, 'src/db/index.js'));
const { createStorage } = await import(path.join(SERVER, 'src/lib/storage.js'));
const { newId } = await import(path.join(SERVER, 'src/lib/ids.js'));
const { enqueue } = await import(path.join(SERVER, 'src/jobs/queue.js'));

const { values: args } = parseArgs({
  options: {
    fixtures: { type: 'string', default: '/work/fixtures' },
    out: { type: 'string', default: '/work/smoke' },
    'timeout-seconds': { type: 'string', default: '900' },
  },
});

const FIXTURES = path.resolve(args.fixtures);
const OUT = path.resolve(args.out);
const DATA_DIR = path.join(OUT, 'data');
const MEDIA_DIR = path.join(OUT, 'media');
const SENTINEL = '.gma-media';
const TIMEOUT_MS = Number(args['timeout-seconds']) * 1000;

const log = (...parts) => console.log('[smoke]', ...parts);

// ---------------------------------------------------------------------------
// The fixtures (deploy/ci/make-fixtures.sh made them)

const INPUTS = [
  { key: 'heic', kind: 'photo', file: 'photo.heic', mime: 'image/heic', ext: 'heic', label: 'HEIC photo (heif-enc, with GPS)' },
  { key: 'jpeg', kind: 'photo', file: 'photo-gps.jpg', mime: 'image/jpeg', ext: 'jpg', label: 'JPEG photo (with GPS)' },
  { key: 'portrait', kind: 'video', file: 'portrait-1080x1920-h264.mov', mime: 'video/quicktime', ext: 'mov', label: '10 s 1080x1920 portrait H.264' },
  { key: 'hdr', kind: 'video', file: 'hdr-3840x2160-hevc10-hlg.mov', mime: 'video/quicktime', ext: 'mov', label: '5 s 3840x2160 HEVC 10-bit HLG' },
];
const VOICE = { file: 'voice.webm', ext: 'webm', label: 'WebM/Opus voice note (stereo)' };

function ffprobe(file) {
  const out = execFileSync('ffprobe', ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', file], {
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
  });
  return JSON.parse(out);
}

// Fully decodes a file; throws with ffmpeg's error when it can't.
function decodes(file) {
  try {
    execFileSync('ffmpeg', ['-v', 'error', '-nostdin', '-i', file, '-f', 'null', '-'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    return [];
  } catch (err) {
    return [`ffmpeg could not decode it: ${String(err.stderr || err.message).trim().split('\n').slice(-2).join(' / ')}`];
  }
}

function fileBytesInclude(file, needle) {
  return fs.readFileSync(file).includes(Buffer.from(needle, 'latin1'));
}

// The location string make-fixtures.sh wrote into the clips.
const FIXTURE_LOCATION = '+40.7128-074.0060';

// Proves the inputs are what the test claims, so a pass means something.
async function checkInputs() {
  const results = [];
  for (const input of INPUTS) {
    const file = path.join(FIXTURES, input.file);
    const problems = [];
    if (!fs.existsSync(file)) {
      results.push({ name: `fixture ${input.file} exists`, problems: ['missing'] });
      continue;
    }
    if (input.kind === 'video') {
      const probe = ffprobe(file);
      const v = probe.streams.find((s) => s.codec_type === 'video');
      if (input.key === 'hdr') {
        if (v.codec_name !== 'hevc') problems.push(`codec is ${v.codec_name}, not hevc`);
        if (!String(v.pix_fmt).includes('10')) problems.push(`pixel format ${v.pix_fmt} is not 10-bit`);
        if (v.color_transfer !== 'arib-std-b67') problems.push(`transfer is ${v.color_transfer}, not arib-std-b67 (HLG)`);
        if (`${v.width}x${v.height}` !== '3840x2160') problems.push(`size is ${v.width}x${v.height}`);
      } else {
        if (v.codec_name !== 'h264') problems.push(`codec is ${v.codec_name}, not h264`);
        if (`${v.width}x${v.height}` !== '1080x1920') problems.push(`size is ${v.width}x${v.height}`);
      }
      if (!fileBytesInclude(file, FIXTURE_LOCATION)) problems.push('the clip carries no location to strip');
      if (!probe.format.tags?.creation_time) problems.push('the clip carries no creation_time to strip');
    } else if (input.key === 'jpeg') {
      const meta = await sharp(file).metadata();
      if (!exifHasGps(meta.exif)) problems.push('the JPEG carries no GPS to strip');
    } else if (input.key === 'heic') {
      const info = execFileSync('heif-info', [file], { encoding: 'utf8' });
      if (!/Exif/i.test(info)) problems.push('the HEIC carries no EXIF block');
      if (!/hvc1|hevc/i.test(info) && !fileBytesInclude(file, 'hvcC')) problems.push('the HEIC is not HEVC-coded');
    }
    results.push({ name: `fixture: ${input.label}`, problems });
  }
  const voice = path.join(FIXTURES, VOICE.file);
  const vp = fs.existsSync(voice) ? ffprobe(voice) : null;
  const a = vp?.streams.find((s) => s.codec_type === 'audio');
  results.push({
    name: `fixture: ${VOICE.label}`,
    problems: !a ? ['missing'] : [a.codec_name !== 'opus' && `codec is ${a.codec_name}`, a.channels !== 2 && `${a.channels} channels`].filter(Boolean),
  });
  return results;
}

// ---------------------------------------------------------------------------
// Database and media

async function setUp() {
  await fsp.rm(OUT, { recursive: true, force: true });
  await fsp.mkdir(DATA_DIR, { recursive: true });
  await fsp.mkdir(MEDIA_DIR, { recursive: true });
  await fsp.writeFile(path.join(MEDIA_DIR, SENTINEL), 'gma smoke test\n');

  const db = openDb(path.join(DATA_DIR, 'gma.sqlite'));
  const storage = createStorage(MEDIA_DIR, { sentinel: SENTINEL });
  await storage.init();

  const now = Date.now();
  const userId = newId();
  db.prepare(
    `INSERT INTO users (id, name, email, role, status, created_at, activated_at) VALUES (?, 'Sarah', 'sarah@example.test', 'member', 'active', ?, ?)`,
  ).run(userId, now, now);

  const items = {};
  // The 4K HDR clip first: the worker runs one video at a time, oldest first,
  // so its timing isn't mixed up with the portrait clip's.
  const order = ['hdr', 'portrait', 'heic', 'jpeg'];
  for (const key of order) {
    const input = INPUTS.find((i) => i.key === key);
    const id = newId();
    const original = storage.originalKey(id, input.ext);
    const target = await storage.ensureDirFor(original);
    await fsp.copyFile(path.join(FIXTURES, input.file), target);
    const { size } = await fsp.stat(target);
    db.prepare(
      `INSERT INTO items (id, user_id, kind, status, original_path, original_mime, original_bytes, created_at)
       VALUES (?, ?, ?, 'processing', ?, ?, ?, ?)`,
    ).run(id, userId, input.kind, original, input.mime, size, Date.now());
    const jobId = enqueue(db, { kind: input.kind === 'photo' ? 'image' : 'video', refId: id });
    items[key] = { ...input, id, jobId };
  }

  const voiceId = newId();
  const voiceOriginal = storage.originalKey(voiceId, VOICE.ext);
  await fsp.copyFile(path.join(FIXTURES, VOICE.file), await storage.ensureDirFor(voiceOriginal));
  db.prepare(
    `INSERT INTO voice_notes (id, user_id, item_id, status, original_path, created_at) VALUES (?, ?, ?, 'processing', ?, ?)`,
  ).run(voiceId, userId, items.heic.id, voiceOriginal, Date.now());
  const voiceJobId = enqueue(db, { kind: 'voice', refId: voiceId });

  return { db, storage, items, voice: { id: voiceId, jobId: voiceJobId } };
}

// ---------------------------------------------------------------------------
// The worker

function startWorker() {
  const env = {
    PATH: process.env.PATH,
    HOME: '/tmp',
    NODE_ENV: 'production',
    PUBLIC_URL: 'https://gma-ci.invalid',
    SECRET_KEY: Buffer.alloc(48, 9).toString('base64'),
    DATA_DIR,
    MEDIA_DIR,
    MEDIA_SENTINEL: SENTINEL,
    EMAIL_TRANSPORT: 'console',
    LOG_LEVEL: 'info',
  };
  const child = spawn(process.execPath, ['src/worker.js'], { cwd: SERVER, env, stdio: ['ignore', 'pipe', 'pipe'] });
  const prefix = (stream, tag) => {
    let rest = '';
    stream.setEncoding('utf8');
    stream.on('data', (chunk) => {
      const lines = (rest + chunk).split('\n');
      rest = lines.pop();
      for (const line of lines) if (line.trim()) console.log(`  ${tag} ${line}`);
    });
  };
  prefix(child.stdout, 'worker|');
  prefix(child.stderr, 'worker!');
  return child;
}

function stopWorker(child) {
  return new Promise((resolve) => {
    if (child.exitCode !== null) return resolve(child.exitCode);
    const kill = setTimeout(() => child.kill('SIGKILL'), 45_000);
    child.once('exit', (code) => {
      clearTimeout(kill);
      resolve(code);
    });
    child.kill('SIGTERM');
  });
}

// Polls the jobs table until every job is done or failed, noting when each one
// was first seen running and when it finished (±250 ms).
async function waitForJobs(db, jobIds, worker) {
  const seen = new Map(jobIds.map((id) => [id, { startedAt: null, endedAt: null, status: 'queued', error: null }]));
  const started = Date.now();
  const get = db.prepare('SELECT status, error, attempts FROM jobs WHERE id = ?');
  while (true) {
    for (const id of jobIds) {
      const row = get.get(id);
      const s = seen.get(id);
      if (row.status === 'running' && !s.startedAt) s.startedAt = Date.now();
      if ((row.status === 'done' || row.status === 'failed' || (row.status === 'queued' && row.attempts > 0)) && !s.endedAt) {
        s.endedAt = Date.now();
        s.startedAt ??= s.endedAt;
      }
      s.status = row.status;
      s.error = row.error;
      s.attempts = row.attempts;
    }
    if ([...seen.values()].every((s) => s.endedAt)) return { seen, totalMs: Date.now() - started };
    if (worker.exitCode !== null) throw new Error(`the worker exited early with code ${worker.exitCode}`);
    if (Date.now() - started > TIMEOUT_MS) throw new Error(`jobs still unfinished after ${formatSeconds(TIMEOUT_MS)}`);
    await new Promise((r) => setTimeout(r, 250));
  }
}

// ---------------------------------------------------------------------------
// Checks on the renditions

const renditionsOf = (db, itemId) =>
  Object.fromEntries(db.prepare('SELECT * FROM renditions WHERE item_id = ?').all(itemId).map((r) => [r.name, r]));

async function checkPhoto(db, storage, item) {
  const results = [];
  const row = db.prepare('SELECT status, error FROM items WHERE id = ?').get(item.id);
  results.push({ name: `${item.label}: item is ready`, problems: row.status === 'ready' ? [] : [`status ${row.status}: ${row.error}`] });
  const r = renditionsOf(db, item.id);
  const specs = { thumb: ['webp', 480], display: ['mjpeg', 1600], large: ['mjpeg', 2560] };
  for (const [name, [codec, maxSide]] of Object.entries(specs)) {
    if (!r[name]) {
      results.push({ name: `${item.label}: ${name} rendition`, problems: ['missing'] });
      continue;
    }
    const file = storage.resolve(r[name].path);
    const meta = await sharp(file).metadata();
    results.push({
      name: `${item.label}: ${name} (${meta.width}x${meta.height} ${meta.format}) decodes, no EXIF/GPS`,
      problems: [...decodes(file), ...checkStill(ffprobe(file), { codec, maxSide }), ...checkStillMetadata(meta)],
    });
  }
  return results;
}

async function checkVideo(db, storage, item) {
  const results = [];
  const row = db.prepare('SELECT status, error, width, height, duration_ms FROM items WHERE id = ?').get(item.id);
  results.push({ name: `${item.label}: item is ready`, problems: row.status === 'ready' ? [] : [`status ${row.status}: ${row.error}`] });
  const r = renditionsOf(db, item.id);
  if (!r.video) {
    results.push({ name: `${item.label}: video rendition`, problems: ['missing'] });
  } else {
    const file = storage.resolve(r.video.path);
    const probe = ffprobe(file);
    const v = probe.streams.find((s) => s.codec_type === 'video');
    const buf = fs.readFileSync(file);
    const problems = [...checkVideoRendition(probe), ...checkFaststart(buf)];
    if (buf.includes(Buffer.from(FIXTURE_LOCATION, 'latin1'))) problems.push('the location string is still in the file');
    problems.push(...decodes(file));
    results.push({
      name: `${item.label}: video ${v?.width}x${v?.height} ${v?.codec_name} ${v?.profile} ${v?.pix_fmt} ${v?.color_transfer ?? ''} ${(r.video.bytes / 1e6).toFixed(1)} MB`,
      problems,
    });
  }
  for (const [name, codec, maxSide] of [['poster', 'mjpeg', 1600], ['thumb', 'webp', 480]]) {
    if (!r[name]) {
      results.push({ name: `${item.label}: ${name}`, problems: ['missing'] });
      continue;
    }
    const file = storage.resolve(r[name].path);
    const meta = await sharp(file).metadata();
    results.push({
      name: `${item.label}: ${name} (${meta.width}x${meta.height}) exists and decodes`,
      problems: [...decodes(file), ...checkStill(ffprobe(file), { codec, maxSide }), ...checkStillMetadata(meta)],
    });
  }
  return results;
}

function checkVoice(db, storage, voice) {
  const row = db.prepare('SELECT status, audio_path, duration_ms FROM voice_notes WHERE id = ?').get(voice.id);
  if (row.status !== 'ready' || !row.audio_path) return [{ name: 'voice note is ready', problems: [`status ${row.status}`] }];
  const file = storage.resolve(row.audio_path);
  const probe = ffprobe(file);
  const a = probe.streams.find((s) => s.codec_type === 'audio');
  return [
    {
      name: `voice note: ${path.basename(file)} ${a?.codec_name} ${a?.channels} ch ${a?.sample_rate} Hz ${formatSeconds(row.duration_ms ?? 0)}`,
      problems: [...checkVoiceRendition(probe), ...checkFaststart(fs.readFileSync(file)), ...decodes(file)],
    },
  ];
}

// ---------------------------------------------------------------------------

function firstLine(tool, toolArgs) {
  try {
    return execFileSync(tool, toolArgs, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim().split('\n')[0];
  } catch (err) {
    return String(err.stdout || err.stderr || 'version unknown').trim().split('\n')[0];
  }
}

function cpuLimit() {
  try {
    const [quota, period] = fs.readFileSync('/sys/fs/cgroup/cpu.max', 'utf8').trim().split(/\s+/);
    return quota === 'max' ? 'none' : `${(Number(quota) / Number(period)).toFixed(2)} CPUs`;
  } catch {
    try {
      const quota = Number(fs.readFileSync('/sys/fs/cgroup/cpu/cpu.cfs_quota_us', 'utf8'));
      const period = Number(fs.readFileSync('/sys/fs/cgroup/cpu/cpu.cfs_period_us', 'utf8'));
      return quota > 0 ? `${(quota / period).toFixed(2)} CPUs` : 'none';
    } catch {
      return 'unknown';
    }
  }
}

async function main() {
  log(`ffmpeg: ${firstLine('ffmpeg', ['-version'])}`);
  log(`heif-dec: ${firstLine('heif-dec', ['--version'])}`);
  log(`cpu limit: ${cpuLimit()} (the worker's compose limit is cpus: 3)`);

  const inputResults = await checkInputs();
  const inputSummary = summarise(inputResults);
  for (const line of inputSummary.lines) log(line);
  if (!inputSummary.ok) {
    log('The fixtures are not what the smoke test needs; stopping before the worker runs.');
    process.exit(1);
  }

  const { db, storage, items, voice } = await setUp();
  const jobs = [...Object.values(items).map((i) => ({ id: i.jobId, label: i.label })), { id: voice.jobId, label: VOICE.label }];
  log(`queued ${jobs.length} jobs; starting the worker`);
  const worker = startWorker();
  let timing;
  try {
    timing = await waitForJobs(db, jobs.map((j) => j.id), worker);
  } finally {
    const code = await stopWorker(worker);
    log(`worker stopped (exit ${code})`);
  }

  log('job timings (wall clock, from first seen running to done):');
  for (const job of jobs) {
    const s = timing.seen.get(job.id);
    log(`  ${formatSeconds(s.endedAt - s.startedAt).padStart(8)}  ${s.status.padEnd(6)}  ${job.label}${s.error ? `  error: ${s.error}` : ''}`);
  }
  log(`  ${formatSeconds(timing.totalMs).padStart(8)}  total`);

  const results = [
    ...(await checkPhoto(db, storage, items.heic)),
    ...(await checkPhoto(db, storage, items.jpeg)),
    ...(await checkVideo(db, storage, items.portrait)),
    ...(await checkVideo(db, storage, items.hdr)),
    ...checkVoice(db, storage, voice),
  ];
  db.close();
  const summary = summarise(results);
  for (const line of summary.lines) log(line);

  const hdr = timing.seen.get(items.hdr.jobId);
  const hdrMs = hdr.endedAt - hdr.startedAt;
  log(`4K HEVC 10-bit HLG, 5 s → 720p H.264 (tone map, poster, thumb): ${formatSeconds(hdrMs)} at ${cpuLimit()}, ${(5000 / hdrMs).toFixed(2)}x real time`);
  await fsp.writeFile(
    path.join(OUT, 'timings.json'),
    JSON.stringify(
      {
        cpuLimit: cpuLimit(),
        jobs: jobs.map((j) => ({ label: j.label, ms: timing.seen.get(j.id).endedAt - timing.seen.get(j.id).startedAt, status: timing.seen.get(j.id).status })),
        totalMs: timing.totalMs,
      },
      null,
      2,
    ),
  );
  log(summary.ok ? 'PASS: every rendition matches the contract' : 'FAIL: see the lines above');
  process.exit(summary.ok ? 0 : 1);
}

main().catch((err) => {
  console.error('[smoke] crashed:', err);
  process.exit(1);
});
