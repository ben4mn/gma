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
import { requireUser } from '../lib/guards.js';
import { newId } from '../lib/ids.js';
import { sniffFile } from '../lib/media.js';
import { enqueue } from '../jobs/queue.js';

export const UPLOAD_PATH = '/api/uploads';
export const CAPTION_MAX = 500;
const FILENAME_MAX = 255;
const BATCH_ID = /^[A-Za-z0-9_-]{1,64}$/;
const SCRATCH_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const SWEEP_EVERY_MS = 60 * 60 * 1000;

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

export default async function uploadRoutes(app, { config, db }) {
  const { storage } = app;
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
      db.transaction(() => {
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
      })();
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
    respectForwardedHeaders: config.trustProxy,
    // A relative Location survives nginx and the tunnel whatever they forward.
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
      return { metadata: normaliseMetadata(upload.metadata ?? {}, user.id) };
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

  // tus reads the request body itself, straight from the socket.
  app.addContentTypeParser('application/offset+octet-stream', (request, payload, done) => done(null));

  // tus's web API (handleWeb) with a standard Request: the hooks get exactly
  // this object back, and the response is small enough to write directly.
  const handler = async (request, reply) => {
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
      preHandler: requireUser,
      bodyLimit: config.maxUploadBytes,
      handler,
    });
  }

  const sweeper = setInterval(() => {
    sweepScratch(storage.uploadsDir).catch((err) => app.log.warn({ err }, 'Could not sweep old upload chunks'));
  }, SWEEP_EVERY_MS);
  sweeper.unref();
  app.addHook('onClose', async () => clearInterval(sweeper));
}
