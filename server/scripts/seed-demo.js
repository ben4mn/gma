#!/usr/bin/env node
// Fills an empty database with a fake family so the app has something to show:
// demo members (emails at demo.invalid), photos from design/assets/photos copied
// in as originals with image jobs queued for the worker, a couple of generated
// videos and a voice message when ffmpeg is installed, a paired "Demo frame"
// (its link is printed once) and a few of Grandma's reactions and messages.
//
// It never touches real family data: it refuses to run unless you pass --yes
// and the database has no members outside demo.invalid. In production it also
// wants --allow-production.
//
//   npm run seed:demo -- --yes            then run the worker so the photos get processed

import { execFile, spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import sharp from 'sharp';
import { newId } from '../src/lib/ids.js';
import { createStorage } from '../src/lib/storage.js';
import { HOUR, MINUTE } from '../src/lib/time.js';
import { logAdmin, pairDevice } from '../src/lib/admin.js';
import { EXIT, openFromEnv, parseFlags, runIfMain } from './lib/cli.js';

const run = promisify(execFile);

export const USAGE = 'Usage: npm run seed:demo -- --yes [--photos <dir>] [--no-video] [--allow-production]';
export const DEMO_DOMAIN = 'demo.invalid';
const DEFAULT_PHOTOS_DIR = fileURLToPath(new URL('../../design/assets/photos/', import.meta.url));
const PHOTO_TYPES = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp' };

const FAMILY = [
  { key: 'admin', name: 'Demo Admin', role: 'admin', color: '#3A5236' },
  { key: 'sarah', name: 'Sarah Lee', color: '#8A3517' },
  { key: 'mike', name: 'Mike Lee', color: '#6B4F1D' },
  { key: 'lily', name: 'Lily Lee', color: '#3D4A55' },
  { key: 'ruth', name: 'Ruth Alvarez', color: '#8A3517' },
  { key: 'jamal', name: 'Jamal Brooks', color: '#3A5236' },
  { key: 'tom', name: 'Tom Alvarez', color: '#6B4F1D' },
  { key: 'priya', name: 'Priya Shah', color: '#3D4A55', pending: true }, // invited, hasn't signed in
];

// Newest first. `photos` is how many pictures the post has; `video` makes it a video post.
const POSTS = [
  { who: 'mike', hoursAgo: 2, photos: 3, caption: 'Sunday at the lake' },
  { who: 'sarah', hoursAgo: 5, photos: 1, caption: "Lily's first day of school" },
  { who: 'tom', hoursAgo: 9, video: true, caption: 'The kids singing for you' },
  { who: 'lily', hoursAgo: 20, photos: 2, caption: 'Pancakes for breakfast!' },
  { who: 'ruth', hoursAgo: 34, photos: 4, caption: 'The garden is blooming' },
  { who: 'jamal', hoursAgo: 50, photos: 2, caption: 'Hiking with Biscuit' },
  { who: 'sarah', hoursAgo: 75, photos: 3, caption: "Mike's birthday party" },
  { who: 'mike', hoursAgo: 100, video: true, caption: 'First fish of the summer' },
  { who: 'admin', hoursAgo: 140, photos: 2, caption: 'Old photos I found in a box' },
  { who: 'lily', hoursAgo: 170, photos: 3, caption: null },
];

// Grandma's answers: [post index, kind, reaction or preset text, minutes after the post].
const GRANDMA = [
  [0, 'reaction', 'love', 40],
  [1, 'preset', 'Proud of you', 90],
  [3, 'reaction', 'funny', 60],
  [4, 'reaction', 'thankful', 120],
  [5, 'reaction', 'wow', 30],
  [6, 'preset', 'Call me', 200],
];

export class SeedRefused extends Error {}

function countUsers(db) {
  const row = db
    .prepare(
      `SELECT SUM(lower(email) LIKE '%@' || ?) AS demo, SUM(lower(email) NOT LIKE '%@' || ?) AS real FROM users`,
    )
    .get(DEMO_DOMAIN, DEMO_DOMAIN);
  return { demo: row.demo ?? 0, real: row.real ?? 0 };
}

export function findFfmpeg() {
  const probe = spawnSync('ffmpeg', ['-hide_banner', '-version'], { stdio: 'ignore' });
  return probe.status === 0 ? 'ffmpeg' : null;
}

async function listPhotos(dir) {
  let names;
  try {
    names = await fs.readdir(dir);
  } catch {
    return [];
  }
  return names
    .filter((n) => PHOTO_TYPES[path.extname(n).toLowerCase()])
    .sort()
    .map((n) => ({ file: path.join(dir, n), mime: PHOTO_TYPES[path.extname(n).toLowerCase()] }));
}

// Plain warm-coloured pictures, for when the sample photos aren't there (the Docker image).
async function placeholderPhotos(tempDir) {
  const colours = ['#C9A27E', '#8FA58A', '#B8862B', '#A86A55', '#7D8FA0', '#D8C3A5'];
  const out = [];
  for (const [i, colour] of colours.entries()) {
    const file = path.join(tempDir, `placeholder-${i}.jpg`);
    await sharp({ create: { width: 1600, height: 1067, channels: 3, background: colour } }).jpeg({ quality: 80 }).toFile(file);
    out.push({ file, mime: 'image/jpeg' });
  }
  return out;
}

async function ffmpegTo(ffmpeg, outFile, inputArgs) {
  await run(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', ...inputArgs, outFile], { timeout: 120_000 });
}

function sampleVideoArgs(seconds, frequency) {
  return [
    '-f', 'lavfi', '-i', `testsrc2=size=1280x720:rate=30:duration=${seconds}`,
    '-f', 'lavfi', '-i', `sine=frequency=${frequency}:duration=${seconds}`,
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest',
  ];
}

function sampleVoiceArgs(seconds) {
  return ['-f', 'lavfi', '-i', `sine=frequency=330:duration=${seconds}`, '-ac', '1', '-c:a', 'aac', '-b:a', '64k'];
}

// The temp file an original is made in, next to its final place. It ends in
// the real extension (<id>.mp4.tmp-<hex>.mp4), because ffmpeg picks its output
// format from the name: a bare ".tmp-<hex>" made every sample video and voice
// message fail.
export function tempOriginalPath(storage, key, ext) {
  return `${storage.tempPathFor(key)}.${ext}`;
}

// Copies or generates one original into storage and returns its row fields.
async function placeOriginal(storage, { id, ext, createdAt, from = null, make = null }) {
  const key = storage.originalKey(id, ext, createdAt);
  const final = await storage.ensureDirFor(key);
  const temp = tempOriginalPath(storage, key, ext);
  try {
    if (from) await fs.copyFile(from, temp);
    else await make(temp);
    await fs.rename(temp, final);
  } catch (err) {
    await fs.rm(temp, { force: true });
    throw err;
  }
  return { key, bytes: (await fs.stat(final)).size };
}

// The seed itself. Options: photosDir, ffmpeg (a binary name, or null to skip
// video and voice), log(line). Returns a summary including the frame's link.
export async function seedDemo({ config, db, storage, photosDir = DEFAULT_PHOTOS_DIR, ffmpeg = null, log = () => {} }) {
  const users = countUsers(db);
  if (users.real > 0) throw new SeedRefused('This database has real family members in it, so the demo seed will not touch it.');
  if (users.demo > 0) throw new SeedRefused('Demo data is already here.');
  await storage.init();

  const now = Date.now();
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'gma-seed-'));
  const summary = { users: 0, photos: 0, videos: 0, voiceNotes: 0, grandmaEvents: 0, frameUrl: null, notes: [] };

  try {
    let photos = await listPhotos(photosDir);
    if (photos.length === 0) {
      summary.notes.push(`No sample photos in ${photosDir}, so plain coloured pictures were used instead.`);
      photos = await placeholderPhotos(tempDir);
    }
    if (!ffmpeg) summary.notes.push('ffmpeg is not installed here, so the demo has no videos or voice message.');

    // 1. Files first, so a failure leaves no rows pointing at missing media.
    const items = [];
    const voiceNotes = [];
    let photoIndex = 0;
    for (const [postIndex, post] of POSTS.entries()) {
      const createdAt = now - post.hoursAgo * HOUR;
      const batchId = newId(createdAt);
      if (post.video) {
        if (!ffmpeg) continue;
        const id = newId(createdAt);
        try {
          const placed = await placeOriginal(storage, {
            id,
            ext: 'mp4',
            createdAt,
            make: (out) => ffmpegTo(ffmpeg, out, sampleVideoArgs(6, 440 + postIndex * 40)),
          });
          items.push({ id, postIndex, who: post.who, kind: 'video', caption: post.caption, batchId, createdAt, mime: 'video/mp4', ...placed });
        } catch (err) {
          summary.notes.push(`Could not make a sample video (${err.message.split('\n')[0]}).`);
        }
        continue;
      }
      for (let i = 0; i < post.photos; i++) {
        const photo = photos[photoIndex++ % photos.length];
        const at = createdAt + i * 1000;
        const id = newId(at);
        const ext = path.extname(photo.file).slice(1).toLowerCase();
        const placed = await placeOriginal(storage, { id, ext, createdAt: at, from: photo.file });
        items.push({ id, postIndex, who: post.who, kind: 'photo', caption: post.caption, batchId, createdAt: at, mime: photo.mime, ...placed });
      }
    }
    if (ffmpeg) {
      const createdAt = now - 3 * HOUR;
      const id = newId(createdAt);
      try {
        const placed = await placeOriginal(storage, {
          id,
          ext: 'm4a',
          createdAt,
          make: (out) => ffmpegTo(ffmpeg, out, sampleVoiceArgs(8)),
        });
        voiceNotes.push({ id, createdAt, ...placed });
      } catch (err) {
        summary.notes.push(`Could not make a sample voice message (${err.message.split('\n')[0]}).`);
      }
    }

    // 2. Rows, all at once.
    db.transaction(() => {
      const userIds = {};
      const insertUser = db.prepare(
        `INSERT INTO users (id, name, email, role, status, color, created_at, activated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      for (const person of FAMILY) {
        const created = now - 30 * 24 * HOUR;
        userIds[person.key] = newId(created);
        insertUser.run(
          userIds[person.key],
          person.name,
          `${person.key}@${DEMO_DOMAIN}`,
          person.role ?? 'member',
          person.pending ? 'pending' : 'active',
          person.color,
          created,
          person.pending ? null : created,
        );
        summary.users += 1;
      }

      const insertItem = db.prepare(
        `INSERT INTO items (id, user_id, kind, caption, batch_id, status, original_path, original_mime, original_bytes, created_at)
         VALUES (?, ?, ?, ?, ?, 'processing', ?, ?, ?, ?)`,
      );
      const insertJob = db.prepare(
        `INSERT INTO jobs (id, kind, ref_id, status, attempts, max_attempts, run_after, created_at, updated_at)
         VALUES (?, ?, ?, 'queued', 0, 3, ?, ?, ?)`,
      );
      // Oldest first, so the worker processes them in the order they were "sent".
      for (const item of [...items].sort((a, b) => a.createdAt - b.createdAt)) {
        insertItem.run(item.id, userIds[item.who], item.kind, item.caption, item.batchId, item.key, item.mime, item.bytes, item.createdAt);
        insertJob.run(newId(), item.kind === 'video' ? 'video' : 'image', item.id, now, now, now);
        summary[item.kind === 'video' ? 'videos' : 'photos'] += 1;
      }

      const frame = pairDevice(db, { name: 'Demo frame', createdBy: null, publicUrl: config.publicUrl });
      summary.frameUrl = frame.url;

      for (const note of voiceNotes) {
        db.prepare(
          `INSERT INTO voice_notes (id, device_id, status, original_path, client_id, created_at)
           VALUES (?, ?, 'processing', ?, ?, ?)`,
        ).run(note.id, frame.device.id, note.key, `demo-${note.id}`, note.createdAt);
        // The voice job makes the grandma_events row when the audio is ready.
        insertJob.run(newId(), 'voice', note.id, now, now, now);
        summary.voiceNotes += 1;
      }

      const presetId = db.prepare('SELECT id FROM presets WHERE text = ? AND active = 1');
      const insertEvent = db.prepare(
        `INSERT INTO grandma_events (id, device_id, kind, item_id, reaction, preset_id, preset_text, recipient_user_id, client_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      for (const [postIndex, kind, value, minutesAfter] of GRANDMA) {
        const item = items.find((i) => i.postIndex === postIndex);
        if (!item) continue;
        const at = Math.min(item.createdAt + minutesAfter * MINUTE, now - MINUTE);
        const id = newId(at);
        const preset = kind === 'preset' ? presetId.get(value) : null;
        if (kind === 'preset' && !preset) continue; // Ben renamed that preset
        insertEvent.run(
          id,
          frame.device.id,
          kind,
          item.id,
          kind === 'reaction' ? value : null,
          preset?.id ?? null,
          kind === 'preset' ? value : null,
          userIds[item.who],
          `demo-${id}`,
          at,
        );
        summary.grandmaEvents += 1;
      }

      logAdmin(db, { action: 'cli.seed_demo', target: frame.device.id, detail: { ...summary, frameUrl: undefined } });
    })();
    log(`Seeded ${summary.users} demo people, ${summary.photos} photos, ${summary.videos} videos and ${summary.voiceNotes} voice messages.`);
    return summary;
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
}

export async function main(argv, { env = process.env, out = console, ffmpeg } = {}) {
  const flags = parseFlags(argv, {
    yes: { type: 'boolean' },
    photos: { type: 'string' },
    'no-video': { type: 'boolean' },
    'allow-production': { type: 'boolean' },
    help: { type: 'boolean', short: 'h' },
  });
  if (flags.help) {
    out.log(USAGE);
    return EXIT.OK;
  }
  if (!flags.yes) {
    out.error('This adds a fake demo family to the database. Run it again with --yes if that is what you want.');
    return EXIT.FAIL;
  }

  const { config, db } = openFromEnv(env);
  try {
    if (config.isProduction && !flags['allow-production']) {
      out.error('This is a production setup (NODE_ENV=production). Add --allow-production if you really want demo data here.');
      return EXIT.FAIL;
    }
    const summary = await seedDemo({
      config,
      db,
      storage: createStorage(config.mediaDir, { sentinel: config.mediaSentinel }),
      photosDir: flags.photos ? path.resolve(flags.photos) : DEFAULT_PHOTOS_DIR,
      ffmpeg: flags['no-video'] ? null : (ffmpeg !== undefined ? ffmpeg : findFfmpeg()),
      log: (line) => out.log(line),
    });
    for (const note of summary.notes) out.log(`Note: ${note}`);
    out.log('');
    out.log('The demo frame is paired. Open this link to see Grandma’s screen (shown only once):');
    out.log(`  ${summary.frameUrl}`);
    out.log('');
    out.log(`Sign in to the family app as admin@${DEMO_DOMAIN} (the code appears in the app's log with EMAIL_TRANSPORT=console).`);
    out.log('Start the worker (npm run worker) so the photos and videos get processed.');
    return EXIT.OK;
  } catch (err) {
    if (!(err instanceof SeedRefused)) throw err;
    out.error(err.message);
    if (err.message.startsWith('Demo data')) {
      out.error('To start over, stop the app and worker, then delete the data and media folders.');
      out.error('For a new frame link, run: npm run device:pair -- --name "Demo frame"');
    }
    return EXIT.FAIL;
  } finally {
    db.close();
  }
}

await runIfMain(import.meta.url, main, USAGE);
