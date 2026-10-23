// Grandma's frame: pairing and the /api/frame/* routes.
//
//   GET  /grandma?device=<token>  pair this browser as the frame, 302 → /grandma/
//   GET  /api/frame/state         slideshow, "New for you" cards, presets, settings
//   POST /api/frame/seen          { item_ids }
//   POST /api/frame/react         { item_id, reaction, client_id }   idempotent
//   POST /api/frame/preset        { item_id, preset_id, client_id }  idempotent
//   POST /api/frame/voice         multipart: client_id, audio (≤ 5 MB)  idempotent
//   POST /api/frame/heartbeat     { version, online_since }
//   GET  /api/frame/display       night or day for the Pi's screen helper
//                                 (the frame's cookie, or Authorization: Bearer <pairing token>)
//
// The frame's outbox retries anything that didn't get an answer, so every send
// is keyed by its client_id: a repeat returns the original and never pushes twice.
// A 4xx answer is final (the outbox drops it); only network errors and 5xx retry.
//
// The frame shows people by their short name (what Grandma calls them): every
// sender here has `name` = the short name, plus `short_name` and `full_name`.
//
// Route options: `pushSender` replaces web-push's sendNotification (tests).

import fs from 'node:fs/promises';
import multipart from '@fastify/multipart';
import { publish } from '../lib/events.js';
import { authenticate, httpError, requireDevice } from '../lib/guards.js';
import { isId, newId } from '../lib/ids.js';
import { notifyGrandmaEvent, REACTIONS } from '../lib/push.js';
import { createSession, setSessionCookie } from '../lib/sessions.js';
import { getSetting, getSettings } from '../lib/settings.js';
import { DAY, MINUTE, isNight, now } from '../lib/time.js';
import { sha256 } from '../lib/tokens.js';
import { loadFeedEvent } from '../lib/grandma-feed.js';
import { shortNameOf } from '../lib/people.js';
import { perIp } from '../lib/rate-limits.js';
import { itemJson, loadRenditions, renditionUrl } from '../lib/renditions.js';

const SLIDESHOW_LIMIT = 300; // the frame's service worker caches about this many
const NEW_LIMIT = 100;
const NEW_WINDOW_MS = 14 * DAY; // older unseen uploads stay in the slideshow, not in "New for you"
const GROUP_WINDOW_MS = 10 * MINUTE;
const SEEN_MAX_IDS = 500;
const VOICE_MAX_BYTES = 5 * 1024 * 1024;
const CLIENT_ID = /^[A-Za-z0-9_-]{8,100}$/;
const MAX_PRESET_TEXT = 40; // the admin's limit for a preset
// The Pi's screen helper sets the backlight from GET /api/frame/display.
export const BRIGHTNESS_DAY = 100;
export const BRIGHTNESS_NIGHT = 25;

// MediaRecorder's types (codec parameters stripped) → the original's extension.
const VOICE_TYPES = new Map([
  ['audio/webm', 'webm'],
  ['video/webm', 'webm'],
  ['audio/ogg', 'ogg'],
  ['audio/mp4', 'm4a'],
  ['audio/x-m4a', 'm4a'],
  ['video/mp4', 'mp4'],
  ['audio/aac', 'aac'],
  ['audio/mpeg', 'mp3'],
  ['audio/wav', 'wav'],
  ['audio/x-wav', 'wav'],
]);

const NOT_SET_UP_PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>Grandma's frame</title>
</head>
<body>
<main>
<h1>This frame isn't set up yet.</h1>
<p>Ben can fix this.</p>
</main>
</body>
</html>
`;

// ---------------------------------------------------------------------------
// "New for you" cards (pure, exported for tests)

function cardTitle(photos, videos, name) {
  let what;
  if (photos && videos) {
    what = `${photos === 1 ? 'A photo' : `${photos} photos`} and ${videos === 1 ? 'a video' : `${videos} videos`}`;
  } else if (videos) {
    what = videos === 1 ? 'Video' : `${videos} videos`;
  } else {
    what = photos === 1 ? 'Photo' : `${photos} photos`;
  }
  return `${what} from ${name}`;
}

// Groups items (itemJson shape) into cards: one upload batch, or the same
// sender within 10 minutes, is one card ("3 photos from Mike"). Cards come
// newest first; items inside a card in the order they were sent.
export function groupIntoCards(items, windowMs = GROUP_WINDOW_MS) {
  const sorted = [...items].sort((a, b) => a.created_at - b.created_at || (a.id < b.id ? -1 : 1));
  const groups = [];
  const byBatch = new Map(); // `${senderId} ${batchId}` → group (batch ids come from the client, so scope them)
  const lastBySender = new Map();

  for (const item of sorted) {
    const senderId = item.sender.id;
    let group = item.batch_id ? byBatch.get(`${senderId} ${item.batch_id}`) : undefined;
    if (!group) {
      const recent = lastBySender.get(senderId);
      if (recent && item.created_at - recent.lastAt <= windowMs) group = recent;
    }
    if (!group) {
      group = { sender: item.sender, items: [], batchIds: new Set(), lastAt: 0 };
      groups.push(group);
    }
    group.items.push(item);
    group.lastAt = item.created_at;
    if (item.batch_id) {
      group.batchIds.add(item.batch_id);
      byBatch.set(`${senderId} ${item.batch_id}`, group);
    }
    lastBySender.set(senderId, group);
  }

  return groups
    .map((group) => {
      const id = group.batchIds.size === 1 ? [...group.batchIds][0] : group.items[0].id;
      const photos = group.items.filter((i) => i.kind === 'photo').length;
      const videos = group.items.length - photos;
      return {
        id,
        batch_id: id,
        sender: group.sender,
        title: cardTitle(photos, videos, group.sender.name),
        count: group.items.length,
        photos,
        videos,
        created_at: group.lastAt,
        // Every item carries the card's batch_id, so a client that regroups by
        // batch keeps the server's cards.
        items: group.items.map((item) => ({ ...item, batch_id: id })),
      };
    })
    .sort((a, b) => b.created_at - a.created_at);
}

// ---------------------------------------------------------------------------

function badRequest(code, message) {
  return httpError(400, code, message);
}

function requireClientId(value) {
  if (typeof value !== 'string' || !CLIENT_ID.test(value)) {
    throw badRequest('bad_client_id', "That message couldn't be sent. Please try again.");
  }
  return value;
}

function requireItemId(value) {
  if (!isId(value)) throw badRequest('bad_item', "We couldn't tell which photo that was.");
  return value;
}

// The words a queued preset tap carried (the frame keeps them with the tap), or null.
function storedPresetText(value) {
  if (typeof value !== 'string') return null;
  const text = value.trim().replace(/\s+/g, ' ');
  return text && text.length <= MAX_PRESET_TEXT ? text : null;
}

function isUniqueViolation(err) {
  return err?.code === 'SQLITE_CONSTRAINT_UNIQUE' || err?.code === 'SQLITE_CONSTRAINT_PRIMARYKEY';
}

export default async function frameRoutes(app, { config, db, pushSender = undefined }) {
  // Multipart is only for the voice upload, so it lives in this plugin.
  await app.register(multipart, {
    limits: { fileSize: VOICE_MAX_BYTES, files: 1, fields: 4, fieldSize: 1024, parts: 6, headerPairs: 50 },
  });

  const statements = {
    deviceByToken: db.prepare('SELECT * FROM devices WHERE token_hash = ? AND revoked_at IS NULL'),
    anyDeviceByToken: db.prepare('SELECT id, revoked_at FROM devices WHERE token_hash = ?'),
    touchDevice: db.prepare('UPDATE devices SET last_seen_at = ? WHERE id = ?'),
    presets: db.prepare('SELECT id, text, sort FROM presets WHERE active = 1 ORDER BY sort, id'),
    preset: db.prepare('SELECT id, text FROM presets WHERE id = ?'),
    slideshow: db.prepare(
      `SELECT i.*, u.name AS user_name, u.short_name AS user_short_name FROM items i JOIN users u ON u.id = i.user_id
       WHERE i.status = 'ready'
         AND EXISTS (SELECT 1 FROM renditions r WHERE r.item_id = i.id
                     AND r.name = CASE i.kind WHEN 'photo' THEN 'display' ELSE 'poster' END)
       ORDER BY i.id DESC LIMIT ?`,
    ),
    unseen: db.prepare(
      `SELECT i.*, u.name AS user_name, u.short_name AS user_short_name FROM items i JOIN users u ON u.id = i.user_id
       WHERE i.status = 'ready' AND i.created_at >= ?
         AND NOT EXISTS (SELECT 1 FROM item_views v WHERE v.device_id = ? AND v.item_id = i.id)
       ORDER BY i.id DESC LIMIT ?`,
    ),
    readyItem: db.prepare("SELECT id, user_id FROM items WHERE id = ? AND status = 'ready'"),
    markSeen: db.prepare(
      `INSERT OR IGNORE INTO item_views (device_id, item_id, seen_at)
       SELECT ?, id, ? FROM items WHERE id = ?`,
    ),
    eventByClientId: db.prepare('SELECT id, device_id FROM grandma_events WHERE client_id = ?'),
    insertEvent: db.prepare(
      `INSERT INTO grandma_events (id, device_id, kind, item_id, reaction, preset_id, preset_text,
                                   voice_note_id, recipient_user_id, client_id, created_at)
       VALUES (@id, @device_id, @kind, @item_id, @reaction, @preset_id, @preset_text,
               NULL, @recipient_user_id, @client_id, @created_at)`,
    ),
    voiceByClientId: db.prepare('SELECT id, device_id, status FROM voice_notes WHERE client_id = ?'),
    insertVoiceNote: db.prepare(
      `INSERT INTO voice_notes (id, device_id, user_id, item_id, status, original_path, client_id, created_at)
       VALUES (?, ?, NULL, NULL, 'processing', ?, ?, ?)`,
    ),
    insertJob: db.prepare(
      `INSERT INTO jobs (id, kind, ref_id, status, attempts, max_attempts, run_after, created_at, updated_at)
       VALUES (?, 'voice', ?, 'queued', 0, 3, ?, ?, ?)`,
    ),
  };

  const familyPhotoSql = (extraWhere) =>
    db.prepare(
      `SELECT i.id, i.ready_at, r.width, r.height, i.user_id, u.name AS user_name, u.short_name AS user_short_name
       FROM items i
       JOIN renditions r ON r.item_id = i.id AND r.name = 'display'
       JOIN users u ON u.id = i.user_id
       WHERE i.status = 'ready' AND i.kind = 'photo' ${extraWhere}
       ORDER BY i.id DESC LIMIT 1`,
    );
  const familyPhotoBy = {
    chosen: familyPhotoSql('AND i.id = ?'),
    landscape: familyPhotoSql('AND r.width >= r.height'),
    newest: familyPhotoSql(''),
  };

  // Ben may choose the photo behind the voice button (the family_photo_item_id
  // setting); otherwise the newest landscape photo fills the wide button best;
  // otherwise the newest photo.
  function familyPhoto() {
    const chosen = getSetting(db, 'family_photo_item_id', null);
    const row =
      (isId(chosen) && familyPhotoBy.chosen.get(chosen)) || familyPhotoBy.landscape.get() || familyPhotoBy.newest.get();
    if (!row) return null;
    const shortName = shortNameOf({ name: row.user_name, short_name: row.user_short_name }) ?? 'Someone in the family';
    return {
      item_id: row.id,
      url: renditionUrl(row.id, 'display', row.ready_at),
      width: row.width,
      height: row.height,
      sender: { id: row.user_id, name: shortName, short_name: shortName, full_name: row.user_name },
    };
  }

  function itemsJson(rows) {
    const renditions = loadRenditions(db, rows.map((r) => r.id));
    return rows.map((row) => itemJson(row, renditions.get(row.id)));
  }

  function notifyInBackground(eventId, log) {
    notifyGrandmaEvent(db, config, eventId, { sender: pushSender, log }).catch((err) =>
      log.error({ err, eventId }, 'Push for a Grandma event failed'),
    );
  }

  // A repeated client_id: the original event, or a conflict if another frame owns that id.
  function priorEvent(clientId, deviceId) {
    const prior = statements.eventByClientId.get(clientId);
    if (!prior) return null;
    if (prior.device_id !== deviceId) {
      throw httpError(409, 'client_id_taken', "That message couldn't be sent. Please try again.");
    }
    return { event: loadFeedEvent(db, prior.id), duplicate: true };
  }

  // Inserts a reaction or preset event, publishes it and pushes to the photo's
  // owner. The caller has already answered a repeated client_id.
  function recordEvent(request, reply, fields) {
    const deviceId = request.device.id;
    const createdAt = now();
    const id = newId(createdAt);
    let event;
    try {
      db.transaction(() => {
        statements.insertEvent.run({
          id,
          device_id: deviceId,
          reaction: null,
          preset_id: null,
          preset_text: null,
          ...fields,
          created_at: createdAt,
        });
        // Answering a photo means she has seen it.
        statements.markSeen.run(deviceId, createdAt, fields.item_id);
        event = loadFeedEvent(db, id);
        publish(db, 'grandma.event', { event }, 'all');
      })();
    } catch (err) {
      // Another process inserted the same client_id between our check and insert.
      if (isUniqueViolation(err)) {
        const raced = priorEvent(fields.client_id, deviceId);
        if (raced) return reply.code(200).send(raced);
      }
      throw err;
    }
    notifyInBackground(id, request.log);
    return reply.code(201).send({ event, duplicate: false });
  }

  // -------------------------------------------------------------------------
  // Pairing

  app.get('/grandma', { config: perIp(30, '1 minute') }, async (request, reply) => {
    reply.header('cache-control', 'no-store');
    const token = request.query.device;
    if (token === undefined) return reply.redirect('/grandma/', 302);

    const device =
      typeof token === 'string' && token.length >= 20 && token.length <= 200
        ? statements.deviceByToken.get(sha256(token))
        : null;
    if (!device) {
      request.log.warn('Frame pairing refused: unknown or revoked device token');
      return reply.code(403).type('text/html; charset=utf-8').send(NOT_SET_UP_PAGE);
    }

    // The kiosk opens this link at every boot; keep its session instead of
    // piling up a new one each time.
    authenticate(request, reply);
    if (request.device?.id !== device.id) {
      const session = createSession(db, {
        kind: 'device',
        deviceId: device.id,
        userAgent: request.headers['user-agent'],
      });
      setSessionCookie(reply, session.token);
      request.log.info({ device: device.id }, 'Frame paired');
    }
    statements.touchDevice.run(now(), device.id);
    return reply.redirect('/grandma/', 302);
  });

  // -------------------------------------------------------------------------
  // State

  app.get('/api/frame/state', { preHandler: requireDevice }, async (request, reply) => {
    reply.header('cache-control', 'no-store');
    const at = now();
    const settings = getSettings(db, ['night_start', 'night_end', 'timezone', 'max_voice_seconds']);
    let night = false;
    try {
      night = isNight(at, settings);
    } catch (err) {
      request.log.warn({ err }, 'Night hours are misconfigured; treating it as daytime');
    }

    const unseen = itemsJson(statements.unseen.all(at - NEW_WINDOW_MS, request.device.id, NEW_LIMIT));
    return {
      now: at,
      night,
      settings,
      presets: statements.presets.all(),
      slideshow: itemsJson(statements.slideshow.all(SLIDESHOW_LIMIT)),
      new: groupIntoCards(unseen),
      family_photo: familyPhoto(),
    };
  });

  app.post('/api/frame/seen', { preHandler: requireDevice }, async (request) => {
    const ids = request.body?.item_ids;
    if (!Array.isArray(ids) || ids.length > SEEN_MAX_IDS || !ids.every(isId)) {
      throw badRequest('bad_item_ids', "We couldn't tell which photos were seen.");
    }
    const at = now();
    const deviceId = request.device.id;
    let seen = 0;
    db.transaction(() => {
      for (const id of new Set(ids)) seen += statements.markSeen.run(deviceId, at, id).changes;
    })();
    return { ok: true, seen };
  });

  // -------------------------------------------------------------------------
  // Reactions and presets

  app.post('/api/frame/react', { preHandler: requireDevice }, async (request, reply) => {
    const body = request.body ?? {};
    const clientId = requireClientId(body.client_id);
    const itemId = requireItemId(body.item_id);
    if (!Object.hasOwn(REACTIONS, body.reaction)) {
      throw badRequest('bad_reaction', "That reaction isn't one we know.");
    }
    // A repeat is answered before the item check, so a photo hidden since the
    // first send still gets its original answer.
    const prior = priorEvent(clientId, request.device.id);
    if (prior) return reply.code(200).send(prior);

    const item = statements.readyItem.get(itemId);
    if (!item) throw httpError(404, 'item_gone', "That photo isn't on the frame anymore.");
    return recordEvent(request, reply, {
      kind: 'reaction',
      item_id: item.id,
      reaction: body.reaction,
      recipient_user_id: item.user_id,
      client_id: clientId,
    });
  });

  app.post('/api/frame/preset', { preHandler: requireDevice }, async (request, reply) => {
    const body = request.body ?? {};
    const clientId = requireClientId(body.client_id);
    const itemId = requireItemId(body.item_id);
    if (!isId(body.preset_id)) throw badRequest('bad_preset', "We couldn't tell which message that was.");
    const prior = priorEvent(clientId, request.device.id);
    if (prior) return reply.code(200).send(prior);

    const item = statements.readyItem.get(itemId);
    if (!item) throw httpError(404, 'item_gone', "That photo isn't on the frame anymore.");
    // An inactive preset still sends: the frame may have shown it before Ben changed
    // the list. A deleted one still sends the words the frame showed, when the
    // outbox kept them; otherwise 410, which the outbox treats as final.
    const preset = statements.preset.get(body.preset_id);
    const text = preset?.text ?? storedPresetText(body.preset_text);
    if (!text) {
      throw httpError(410, 'preset_gone', "That message isn't available anymore, so it wasn't sent.");
    }
    return recordEvent(request, reply, {
      kind: 'preset',
      item_id: item.id,
      preset_id: preset?.id ?? null,
      preset_text: text,
      recipient_user_id: item.user_id,
      client_id: clientId,
    });
  });

  // -------------------------------------------------------------------------
  // Voice notes. The worker's voice job turns the original into an m4a, then
  // creates the grandma_events row, publishes it and pushes to everyone.

  async function readVoiceUpload(request) {
    if (!request.isMultipart()) {
      throw httpError(415, 'not_multipart', "That recording couldn't be sent. Please try again.");
    }
    let clientId = null;
    let audio = null;
    try {
      for await (const part of request.parts()) {
        if (part.type === 'file') {
          const buffer = await part.toBuffer(); // always drain, even a part we ignore
          if (part.fieldname === 'audio' && !audio) audio = { buffer, mimetype: part.mimetype };
        } else if (part.fieldname === 'client_id') {
          clientId = String(part.value);
        }
      }
    } catch (err) {
      if (err?.statusCode === 413) {
        throw httpError(413, 'too_large', 'That recording is too long to send. Please record a shorter one.');
      }
      throw err;
    }
    return { clientId, audio };
  }

  app.post('/api/frame/voice', { preHandler: requireDevice }, async (request, reply) => {
    const { clientId: rawClientId, audio } = await readVoiceUpload(request);
    const clientId = requireClientId(rawClientId);
    const deviceId = request.device.id;

    const priorVoice = () => {
      const prior = statements.voiceByClientId.get(clientId);
      if (!prior) return null;
      if (prior.device_id !== deviceId) {
        throw httpError(409, 'client_id_taken', "That recording couldn't be sent. Please try again.");
      }
      return { voice_note: { id: prior.id, status: prior.status }, duplicate: true };
    };
    const prior = priorVoice();
    if (prior) return reply.code(200).send(prior);

    if (!audio || audio.buffer.length === 0) {
      throw badRequest('no_audio', 'That recording was empty. Please try again.');
    }
    const type = String(audio.mimetype ?? '').split(';')[0].trim().toLowerCase();
    const ext = VOICE_TYPES.get(type);
    if (!ext) {
      throw httpError(415, 'bad_audio_type', "That recording couldn't be read. Please try again.");
    }

    const createdAt = now();
    const id = newId(createdAt);
    const key = app.storage.originalKey(id, ext, createdAt);
    const finalPath = await app.storage.ensureDirFor(key);
    const tempPath = app.storage.tempPathFor(key);
    try {
      await fs.writeFile(tempPath, audio.buffer, { flag: 'wx' });
      await fs.rename(tempPath, finalPath);
    } catch (err) {
      await fs.rm(tempPath, { force: true });
      throw err;
    }

    try {
      db.transaction(() => {
        statements.insertVoiceNote.run(id, deviceId, key, clientId, createdAt);
        statements.insertJob.run(newId(createdAt), id, createdAt, createdAt, createdAt);
      })();
    } catch (err) {
      await app.storage.remove(key);
      if (isUniqueViolation(err)) {
        const raced = priorVoice();
        if (raced) return reply.code(200).send(raced);
      }
      throw err;
    }
    return reply.code(202).send({ voice_note: { id, status: 'processing' }, duplicate: false });
  });

  // -------------------------------------------------------------------------
  // Heartbeat

  const lastVersion = new Map(); // device id → the version it last reported (for the log only)

  app.post('/api/frame/heartbeat', { preHandler: requireDevice }, async (request) => {
    const body = request.body ?? {};
    if (body.version !== undefined && (typeof body.version !== 'string' || body.version.length > 64)) {
      throw badRequest('bad_version', "The frame's version didn't look right.");
    }
    if (body.online_since !== undefined && body.online_since !== null && !Number.isFinite(body.online_since)) {
      throw badRequest('bad_online_since', "The frame's online time didn't look right.");
    }
    const at = now();
    const deviceId = request.device.id;
    statements.touchDevice.run(at, deviceId);
    if (body.version && lastVersion.get(deviceId) !== body.version) {
      lastVersion.set(deviceId, body.version);
      request.log.info({ device: deviceId, version: body.version }, 'Frame version');
    }
    return { ok: true, now: at };
  });

  // -------------------------------------------------------------------------
  // Display: the Pi's screen helper (outside the browser) asks whether it is
  // night, to dim the backlight. It has no cookie, so it may use the pairing
  // token from the kiosk's URL instead. It never counts as the frame being seen.

  function displayDevice(request, reply) {
    const header = request.headers.authorization;
    if (typeof header === 'string' && /^bearer\s/i.test(header)) {
      const token = header.slice(7).trim();
      const row = token.length >= 20 && token.length <= 200 ? statements.anyDeviceByToken.get(sha256(token)) : null;
      if (!row || row.revoked_at) {
        throw httpError(401, 'unauthorized', 'This frame needs to be paired again. Ask Ben to send a new link.');
      }
      return row;
    }
    authenticate(request, reply);
    if (!request.device) {
      throw httpError(401, 'unauthorized', 'This frame needs to be paired again. Ask Ben to send a new link.');
    }
    return request.device;
  }

  app.get('/api/frame/display', { config: perIp(60, '1 minute') }, async (request, reply) => {
    reply.header('cache-control', 'no-store');
    displayDevice(request, reply);
    const at = now();
    const settings = getSettings(db, ['night_start', 'night_end', 'timezone']);
    let night = false;
    try {
      night = isNight(at, settings);
    } catch (err) {
      request.log.warn({ err }, 'Night hours are misconfigured; treating it as daytime');
    }
    return {
      night,
      night_start: settings.night_start,
      night_end: settings.night_end,
      timezone: settings.timezone,
      brightness_day: BRIGHTNESS_DAY,
      brightness_night: BRIGHTNESS_NIGHT,
      now: at,
    };
  });
}
