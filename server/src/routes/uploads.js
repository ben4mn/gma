// Resumable uploads (tus) at /api/uploads/. The browser sends photos and videos
// in 32 MB chunks (tus-js-client); a dropped connection resumes where it stopped.
//
// - Signed-in family only: the route's requireUser preHandler checks the
//   session cookie, and onIncomingRequest makes sure an upload is only ever
//   continued, checked or cancelled by the person who started it.
// - Metadata: filename, filetype, caption, batch_id. The owner is stamped from
//   the session, never taken from the client.
// - When the last byte lands, the file is sniffed (the client's filetype is not
//   trusted), moved to originals/, and an item (status 'processing') and its job
//   are created in one transaction. The response carries `X-Item-Id`.
// - The Origin check in app.js covers POST/PATCH/DELETE here like everywhere else.

import fs from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import { Server } from '@tus/server';
import { FileStore } from '@tus/file-store';
import { httpError, requireUser } from '../lib/guards.js';
import { newId } from '../lib/ids.js';
import { sniffFile } from '../lib/media.js';
import { enqueue } from '../jobs/queue.js';
import { immediate } from '../lib/tx.js';

export const UPLOAD_PATH = '/api/uploads';
export const CAPTION_MAX = 500;
const FILENAME_MAX = 255;
const BATCH_ID = /^[A-Za-z0-9_-]{1,64}$/;
const SCRATCH_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const SWEEP_EVERY_MS = 60 * 60 * 1000;
// How long a finished upload still answers a retry (OPS-6).
export const FINISHED_UPLOAD_TTL_MS = 24 * 60 * 60 * 1000;

const NOT_SIGNED_IN = { status_code: 401, body: "You're signed out. Please sign in again.\n" };
const NOT_FOUND = { status_code: 404, body: "We couldn't find that upload.\n" };
const WRONG_KIND = {
  status_code: 415,
  body: "That kind of file can't be shared here. Please choose a photo or a video.\n",
};
const CAPTION_TOO_LONG = {
  status_code: 400,
  body: `That caption is too long. Please keep it under ${CAPTION_MAX} characters.\n`,
};

// One person's budget, so a careless or compromised account can't fill the
// drive Ben's other apps share: files and bytes finished in the last 24 hours,
// and a floor of free space every new upload must leave on the drive.
export const UPLOAD_LIMITS = Object.freeze({
  filesPerDay: 200,
  bytesPerDay: 10 * 1024 ** 3, // 10 GB
  minFreeBytes: 50 * 1024 ** 3, // 50 GB (production; 0 elsewhere unless set)
  uploadsPerHour: 120, // new uploads per person (chunks are never limited)
});

// The limits in force for this config (admin health shows the same numbers).
export function uploadLimitsFor(config, overrides = {}) {
  return {
    ...UPLOAD_LIMITS,
    minFreeBytes: config.isProduction ? UPLOAD_LIMITS.minFreeBytes : 0,
    ...overrides,
  };
}
const DAY_MS = 24 * 60 * 60 * 1000;
const OVER_DAILY_BUDGET = {
  status_code: 429,
  body: "You've shared a lot today, thank you! Please send the rest tomorrow.\n",
};
const DRIVE_FULL = {
  status_code: 507,
  body: "Grandma's photo drive is nearly full, so we can't take this one right now. Ben has been told.\n",
};

function clean(value, max) {
  if (typeof value !== 'string') return null;
  const trimmed = value.replace(/[\u0000-\u001f\u007f]/g, ' ').trim();
  return trimmed ? trimmed.slice(0, max) : null;
}

// Checks and normalises the client's Upload-Metadata. Throws a tus error.
export function normaliseMetadata(metadata = {}, userId) {
  const filetype = clean(metadata.filetype, 100);
  if (filetype && !/^(image|video)\//i.test(filetype)) throw WRONG_KIND;
  const rawCaption = typeof metadata.caption === 'string' ? metadata.caption.trim() : '';
  if (rawCaption.length > CAPTION_MAX) throw CAPTION_TOO_LONG;
  const batchId = typeof metadata.batch_id === 'string' && BATCH_ID.test(metadata.batch_id) ? metadata.batch_id : null;
  const out = { user_id: userId };
  const filename = clean(metadata.filename, FILENAME_MAX);
  if (filename) out.filename = filename;
  if (filetype) out.filetype = filetype;
  if (rawCaption) out.caption = rawCaption;
  if (batchId) out.batch_id = batchId;
  return out;
}

// Leftover chunks of uploads nobody finished.
export async function sweepScratch(dir, { maxAgeMs = SCRATCH_MAX_AGE_MS, now = Date.now() } = {}) {
  let removed = 0;
  let names;
  try {
    names = await fs.readdir(dir);
  } catch {
    return 0;
  }
  for (const name of names) {
    const file = path.join(dir, name);
    try {
      const stat = await fs.stat(file);
      if (stat.isFile() && now - stat.mtimeMs > maxAgeMs) {
        await fs.rm(file, { force: true });
        removed += 1;
      }
    } catch {
      // gone already
    }
  }
  return removed;
}

// Forgets finished uploads older than a day. → how many went.
export function sweepFinishedUploads(db, { now = Date.now() } = {}) {
  return db.prepare('DELETE FROM finished_uploads WHERE created_at <= ?').run(now - FINISHED_UPLOAD_TTL_MS).changes;
}

// The finished upload `uploadId` of this person, from the last day, or null.
function finishedUpload(db, uploadId, userId) {
  if (typeof uploadId !== 'string' || !uploadId || !userId) return null;
  return (
    db
      .prepare('SELECT item_id, size FROM finished_uploads WHERE upload_id = ? AND user_id = ? AND created_at > ?')
      .get(uploadId, userId, Date.now() - FINISHED_UPLOAD_TTL_MS) ?? null
  );
}

export default async function uploadRoutes(app, { config, db, uploadLimits = {} }) {
  const { storage } = app;
  const limits = uploadLimitsFor(config, uploadLimits);

  // Throws a tus error when this upload would go over the person's daily
  // budget or leave the drive below its free-space floor.
  async function checkBudget(req, userId, size) {
    const since = Date.now() - DAY_MS;
    const used = db
      .prepare('SELECT COUNT(*) AS files, COALESCE(SUM(original_bytes), 0) AS bytes FROM items WHERE user_id = ? AND created_at > ?')
      .get(userId, since);
    if (used.files >= limits.filesPerDay || used.bytes + (size ?? 0) > limits.bytesPerDay) {
      contextOf(req).log?.warn({ userId, files: used.files, bytes: used.bytes }, 'Upload refused: daily budget');
      throw OVER_DAILY_BUDGET;
    }
    if (limits.minFreeBytes > 0) {
      const disk = await fs.statfs(storage.uploadsDir);
      const free = disk.bavail * disk.bsize;
      if (free - (size ?? 0) < limits.minFreeBytes) {
        contextOf(req).log?.error({ free, size }, 'Upload refused: the media drive is nearly full');
        throw DRIVE_FULL;
      }
    }
  }
  // tus hands its hooks the web Request we built; this maps it back to the
  // signed-in user and the request's logger.
  const contexts = new WeakMap();
  const datastore = new FileStore({ directory: storage.uploadsDir });

  const contextOf = (req) => contexts.get(req) ?? {};
  const userOf = (req) => contextOf(req).user ?? null;

  async function createItem(upload, userId) {
    const scratchPath = path.join(storage.uploadsDir, upload.id);
    const type = await sniffFile(scratchPath).catch(() => null);
    if (!type || (type.kind !== 'photo' && type.kind !== 'video')) {
      await datastore.remove(upload.id).catch(() => {});
      throw WRONG_KIND;
    }

    const createdAt = Date.now();
    const itemId = newId(createdAt);
    const key = storage.originalKey(itemId, type.ext, createdAt);
    const finalPath = await storage.ensureDirFor(key);
    await fs.rename(scratchPath, finalPath);
    await fs.rm(`${scratchPath}.json`, { force: true });

    try {
      immediate(db, () => {
        db.prepare(
          `INSERT INTO items (id, user_id, kind, caption, batch_id, status, original_path, original_mime, original_bytes, created_at)
           VALUES (?, ?, ?, ?, ?, 'processing', ?, ?, ?, ?)`,
        ).run(
          itemId,
          userId,
          type.kind,
          upload.metadata?.caption ?? null,
          upload.metadata?.batch_id ?? null,
          key,
          type.mime,
          upload.size ?? upload.offset,
          createdAt,
        );
        enqueue(db, { kind: type.kind === 'video' ? 'video' : 'image', refId: itemId, now: createdAt });
        db.prepare('INSERT INTO finished_uploads (upload_id, user_id, item_id, size, created_at) VALUES (?, ?, ?, ?, ?)').run(
          upload.id,
          userId,
          itemId,
          upload.size ?? upload.offset,
          createdAt,
        );
      });
    } catch (err) {
      await fs.rm(finalPath, { force: true });
      throw err;
    }
    return itemId;
  }

  const tus = new Server({
    path: UPLOAD_PATH,
    datastore,
    maxSize: config.maxUploadBytes,
    // A relative Location survives the tunnel whatever it forwards, so tus never
    // needs X-Forwarded-Host/-Proto and is told not to read them.
    respectForwardedHeaders: false,
    relativeLocation: true,
    disableTerminationForFinishedUploads: true,
    allowedOrigins: [config.publicOrigin],
    allowedCredentials: true,
    exposedHeaders: ['X-Item-Id'],

    async onIncomingRequest(req, uploadId) {
      const user = userOf(req);
      if (!user) throw NOT_SIGNED_IN;
      if (req.method === 'POST') return;
      const upload = await datastore.getUpload(uploadId).catch(() => null);
      if (upload && upload.metadata?.user_id !== user.id) throw NOT_FOUND;
    },

    async onUploadCreate(req, upload) {
      const user = userOf(req);
      if (!user) throw NOT_SIGNED_IN;
      const metadata = normaliseMetadata(upload.metadata ?? {}, user.id);
      await checkBudget(req, user.id, upload.size);
      return { metadata };
    },

    async onUploadFinish(req, upload) {
      const user = userOf(req);
      if (!user || upload.metadata?.user_id !== user.id) throw NOT_FOUND;
      const itemId = await createItem(upload, user.id);
      contextOf(req).log?.info({ itemId }, 'Upload finished');
      return { headers: { 'X-Item-Id': itemId } };
    },

    onResponseError(req, err) {
      if (err?.status_code) return undefined; // tus's own and ours: already readable
      contextOf(req).log?.error({ err }, 'Upload failed');
      return { status_code: 500, body: 'Something went wrong on our side. Please try again in a moment.\n' };
    },
  });

  // Only tus bodies here, and none is ever buffered: tus reads the chunk itself,
  // straight from the socket. The root JSON parser is dropped in this plugin, so
  // a JSON (or any other) body is refused with a 415 before a byte of it is
  // read, instead of being parsed into memory. Bodiless tus requests (creation,
  // HEAD, DELETE) carry nothing to parse whatever their Content-Type says.
  app.removeAllContentTypeParsers();
  app.addContentTypeParser('application/offset+octet-stream', (request, payload, done) => done(null));
  app.addContentTypeParser('*', (request, payload, done) => {
    const { 'content-length': length, 'transfer-encoding': chunked } = request.headers;
    if (chunked === undefined && (length === undefined || length === '0')) return done(null);
    done(httpError(415, 'unsupported_media_type', 'Uploads only take photo and video data.'));
  });

  // tus's web API (handleWeb) with a standard Request: the hooks get exactly
  // this object back, and the response is small enough to write directly.
  const handler = async (request, reply) => {
    // A retry after a lost final response: the upload is complete and already an
    // item, so say so (tus-js-client then finishes without sending it again).
    if (request.method === 'HEAD' || request.method === 'PATCH') {
      const done = finishedUpload(db, request.params?.id, request.user?.id);
      if (done) {
        reply.headers({
          'tus-resumable': '1.0.0',
          'upload-offset': String(done.size),
          'cache-control': 'no-store',
          'x-item-id': done.item_id,
        });
        if (request.method === 'HEAD') reply.header('upload-length', String(done.size));
        return reply.code(request.method === 'HEAD' ? 200 : 204).send();
      }
    }
    const hasBody = request.method === 'POST' || request.method === 'PATCH';
    const webRequest = new Request(new URL(request.url, config.publicOrigin), {
      method: request.method,
      headers: Object.entries(request.headers).flatMap(([name, value]) =>
        Array.isArray(value) ? value.map((v) => [name, v]) : [[name, String(value)]],
      ),
      body: hasBody ? Readable.toWeb(request.raw) : null,
      duplex: 'half',
    });
    contexts.set(webRequest, { user: request.user, log: request.log });

    const response = await tus.handleWeb(webRequest);
    const body = request.method === 'HEAD' || !response.body ? null : Buffer.from(await response.arrayBuffer());
    reply.hijack();
    const headers = { ...reply.getHeaders() }; // the security headers app.js set
    for (const [name, value] of response.headers) headers[name] = value;
    reply.raw.writeHead(response.status, headers);
    reply.raw.end(body ?? undefined);
  };

  for (const url of [UPLOAD_PATH, `${UPLOAD_PATH}/`, `${UPLOAD_PATH}/:id`]) {
    app.route({
      method: ['POST', 'HEAD', 'PATCH', 'DELETE'],
      url,
      // New uploads per person (chunks of one upload are PATCHes, never limited).
      config: { rateLimit: { max: limits.uploadsPerHour, timeWindow: '1 hour', keyGenerator: (request) => request.user?.id ?? request.clientIp, allowList: (request) => request.method !== 'POST' } },
      // Signed in before the body is touched (onRequest runs before parsing), so
      // nobody can make the app read a large body without a session.
      onRequest: requireUser,
      handler,
    });
  }

  const sweeper = setInterval(() => {
    sweepScratch(storage.uploadsDir).catch((err) => app.log.warn({ err }, 'Could not sweep old upload chunks'));
    try {
      sweepFinishedUploads(db);
    } catch (err) {
      app.log.warn({ err }, 'Could not forget old finished uploads');
    }
  }, SWEEP_EVERY_MS);
  sweeper.unref();
  app.addHook('onClose', async () => clearInterval(sweeper));
}
