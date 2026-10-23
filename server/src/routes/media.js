// Serving renditions to the family and to Grandma's frame.
//
//   GET /media/:itemId/:name   thumb, display, large, poster or video
//   GET /media/voice/:voiceId  a voice note's m4a
//
// User or device session. Range requests work (Safari and the frame need them
// for video). URLs carry ?v=<ready_at>, so responses are cached for a year as
// immutable; a re-processed item gets a new URL. Originals are never served.

import fs from 'node:fs/promises';
import fastifyStatic from '@fastify/static';
import { httpError, requireUserOrDevice } from '../lib/guards.js';
import { isId } from '../lib/ids.js';
import { canView } from '../lib/item-access.js';

export const ITEM_RENDITIONS = new Set(['thumb', 'display', 'large', 'poster', 'video']);
const CACHE = 'private, max-age=31536000, immutable';

const missing = () => httpError(404, 'not_found', "We couldn't find that. It may have been removed.");

export default async function mediaRoutes(app, { db }) {
  const { storage } = app;
  // serve: false: only reply.sendFile, for files this plugin has checked.
  await app.register(fastifyStatic, {
    root: storage.root,
    serve: false,
    cacheControl: false,
    dotfiles: 'deny',
    acceptRanges: true,
    etag: true,
    lastModified: true,
  });

  async function send(reply, key, mime) {
    // resolve() refuses anything that would escape MEDIA_DIR. Checking the file
    // first keeps a missing one a JSON 404 (once the type is set, it can't be).
    const exists = await fs.stat(storage.resolve(key)).then((s) => s.isFile(), () => false);
    if (!exists) throw missing();
    reply.header('cache-control', CACHE).type(mime);
    return reply.sendFile(key);
  }

  app.get('/media/voice/:voiceId', { preHandler: requireUserOrDevice }, async (request, reply) => {
    const { voiceId } = request.params;
    if (!isId(voiceId)) throw missing();
    const note = db
      .prepare("SELECT audio_path FROM voice_notes WHERE id = ? AND status = 'ready' AND audio_path IS NOT NULL")
      .get(voiceId);
    if (!note) throw missing();
    return send(reply, note.audio_path, 'audio/mp4');
  });

  app.get('/media/:itemId/:name', { preHandler: requireUserOrDevice }, async (request, reply) => {
    const { itemId, name } = request.params;
    if (!isId(itemId) || !ITEM_RENDITIONS.has(name)) throw missing();
    const item = db.prepare('SELECT id, user_id, status FROM items WHERE id = ?').get(itemId);
    if (!item || !canView(item, request)) throw missing();
    const rendition = db.prepare('SELECT path, mime FROM renditions WHERE item_id = ? AND name = ?').get(itemId, name);
    if (!rendition) throw missing();
    return send(reply, rendition.path, rendition.mime);
  });
}
