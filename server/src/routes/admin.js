// The admin API (Ben): people and invites, uploads, Grandma's frame, the preset
// messages, night hours and a health summary. Every route needs an admin, every
// response is no-store, and every change writes an admin_log row (never a token).
//
// The named exports (pairDevice, ensureAdmin, deleteItem, logAdmin, …) are
// shared with the CLIs in server/scripts/.

import fs from 'node:fs/promises';
import { inviteEmail, sendEmail } from '../lib/email.js';
import { publish } from '../lib/events.js';
import { httpError, requireAdmin } from '../lib/guards.js';
import { isId, newId } from '../lib/ids.js';
import { revokeDeviceSessions, revokeUserSessions } from '../lib/sessions.js';
import { getSetting, getSettings, setSettings } from '../lib/settings.js';
import { DAY, isValidClockTime } from '../lib/time.js';
import { randomToken, sha256 } from '../lib/tokens.js';

export const INVITE_LIFE_MS = 14 * DAY;
export const MAX_ACTIVE_PRESETS = 8; // what fits on Grandma's screen
const MAX_PRESETS = 30;
const MAX_PRESET_LENGTH = 40;
const MAX_NAME_LENGTH = 80;
const ITEM_STATUSES = new Set(['processing', 'ready', 'failed', 'hidden']);
const RENDITION_FIELDS = 'item_id, name, mime, width, height, bytes';

// ---------------------------------------------------------------------------
// Validation

function bad(code, message) {
  return httpError(400, code, message);
}

function bodyOf(request) {
  const body = request.body ?? {};
  if (typeof body !== 'object' || Array.isArray(body)) {
    throw bad('bad_request', "That request didn't look right. Please try again.");
  }
  return body;
}

export function cleanName(value, { what = 'their name', max = MAX_NAME_LENGTH } = {}) {
  const name = typeof value === 'string' ? value.trim().replace(/\s+/g, ' ') : '';
  if (!name) throw bad('name_required', `Add ${what}.`);
  if (name.length > max) throw bad('name_too_long', `That name is too long. Keep it under ${max} letters.`);
  return name;
}

export function cleanEmail(value) {
  const email = typeof value === 'string' ? value.trim() : '';
  if (!email) return null;
  if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw bad('bad_email', "That email address doesn't look right. Please check it.");
  }
  return email;
}

function cleanRole(value) {
  if (value === undefined || value === null || value === '') return 'member';
  if (value !== 'member' && value !== 'admin') throw bad('bad_role', 'Choose family member or admin.');
  return value;
}

function idParam(request, what) {
  const { id } = request.params;
  if (!isId(id)) throw httpError(404, 'not_found', `We couldn't find that ${what}.`);
  return id;
}

function isTimeZone(value) {
  if (typeof value !== 'string' || !value) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

function wholeNumberIn(value, min, max) {
  return Number.isInteger(value) && value >= min && value <= max;
}

// The settings Ben can change, each with its check and the sentence he sees when it fails.
const EDITABLE_SETTINGS = {
  night_start: [isValidClockTime, 'The night hours need times like 21:00.'],
  night_end: [isValidClockTime, 'The night hours need times like 07:00.'],
  timezone: [isTimeZone, "We don't know that time zone. Use one like America/Chicago."],
  max_video_seconds: [(v) => wholeNumberIn(v, 10, 600), 'Videos can be from 10 seconds to 10 minutes long.'],
  // The voice job trims at 65 s, so the recorder's limit stays at or under a minute.
  max_voice_seconds: [(v) => wholeNumberIn(v, 10, 60), 'Voice messages can be from 10 to 60 seconds long.'],
};
export const EDITABLE_SETTING_KEYS = Object.freeze(Object.keys(EDITABLE_SETTINGS));

// Returns only the given keys, checked. Throws a 400 with a readable message.
export function validateSettings(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).length === 0) {
    throw bad('nothing_to_save', 'There was nothing to save.');
  }
  const out = {};
  for (const [key, value] of Object.entries(input)) {
    const rule = EDITABLE_SETTINGS[key];
    if (!rule) throw bad('unknown_setting', `"${key}" isn't a setting you can change here.`);
    const [isValid, message] = rule;
    if (!isValid(value)) throw bad('bad_setting', message);
    out[key] = value;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Shared helpers (also used by the CLIs)

export function logAdmin(db, { userId = null, action, target = null, detail = null }) {
  db.prepare('INSERT INTO admin_log (id, user_id, action, target, detail, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(
    newId(),
    userId,
    action,
    target,
    detail === null ? null : JSON.stringify(detail),
    Date.now(),
  );
}

export function pairingUrl(publicUrl, token) {
  return `${publicUrl}/grandma?device=${encodeURIComponent(token)}`;
}

// Makes a device and its pairing token. The token is returned once and only its hash is kept.
export function pairDevice(db, { name, createdBy = null, publicUrl }) {
  const token = randomToken(32);
  const device = {
    id: newId(),
    name,
    token_hash: sha256(token),
    created_by: createdBy,
    created_at: Date.now(),
    last_seen_at: null,
    revoked_at: null,
  };
  db.prepare(
    `INSERT INTO devices (id, name, token_hash, created_by, created_at, last_seen_at, revoked_at)
     VALUES (@id, @name, @token_hash, @created_by, @created_at, @last_seen_at, @revoked_at)`,
  ).run(device);
  return { device: publicDevice(device), token, url: pairingUrl(publicUrl, token) };
}

// Creates an active admin, or promotes/restores the person who has that email.
// Returns { user, outcome } with outcome 'created' | 'promoted' | 'restored' | 'unchanged'.
export function ensureAdmin(db, { name, email }) {
  return db.transaction(() => {
    const existing = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
    const now = Date.now();
    if (!existing) {
      const user = {
        id: newId(now),
        name,
        email,
        role: 'admin',
        status: 'active',
        color: null,
        created_at: now,
        activated_at: now,
        removed_at: null,
      };
      db.prepare(
        `INSERT INTO users (id, name, email, role, status, color, created_at, activated_at, removed_at)
         VALUES (@id, @name, @email, @role, @status, @color, @created_at, @activated_at, @removed_at)`,
      ).run(user);
      return { user, outcome: 'created' };
    }
    if (existing.role === 'admin' && existing.status === 'active') return { user: existing, outcome: 'unchanged' };
    const outcome = existing.status === 'removed' ? 'restored' : 'promoted';
    db.prepare(
      `UPDATE users SET role = 'admin', status = 'active', removed_at = NULL,
         activated_at = COALESCE(activated_at, ?) WHERE id = ?`,
    ).run(now, existing.id);
    return { user: db.prepare('SELECT * FROM users WHERE id = ?').get(existing.id), outcome };
  })();
}

// Deletes an item, its renditions, its original, any voice notes left on it and
// its pending jobs. Grandma's reactions on it stay in her feed (item_id → NULL).
// Returns false when there was no such item.
export async function deleteItem(db, storage, itemId, { log = null } = {}) {
  const item = db.prepare('SELECT id, original_path FROM items WHERE id = ?').get(itemId);
  if (!item) return false;
  const notes = db.prepare('SELECT id, original_path FROM voice_notes WHERE item_id = ?').all(itemId);

  db.transaction(() => {
    const refs = [itemId, ...notes.map((n) => n.id)];
    db.prepare(`DELETE FROM jobs WHERE ref_id IN (${refs.map(() => '?').join(',')})`).run(...refs);
    db.prepare('DELETE FROM items WHERE id = ?').run(itemId); // cascades renditions, views, voice notes
  })();

  // The rows are gone; a file that won't delete is only wasted space, so log it and carry on.
  const removals = [storage.remove(item.original_path), storage.removeRenditions(itemId)];
  for (const note of notes) removals.push(storage.remove(note.original_path), storage.removeRenditions(note.id));
  for (const result of await Promise.allSettled(removals)) {
    if (result.status === 'rejected') log?.warn({ err: result.reason, itemId }, 'Could not delete a media file');
  }
  return true;
}

// ---------------------------------------------------------------------------
// Response shapes

function publicUser(row) {
  return {
    id: row.id,
    name: row.name,
    email: row.email,
    role: row.role,
    status: row.status,
    color: row.color,
    created_at: row.created_at,
    activated_at: row.activated_at,
    removed_at: row.removed_at,
  };
}

function publicInvite(row) {
  return {
    id: row.id,
    name: row.name,
    email: row.email,
    role: row.role,
    sent_at: row.sent_at,
    expires_at: row.expires_at,
    used_at: row.used_at,
    revoked_at: row.revoked_at,
    created_at: row.created_at,
  };
}

function publicDevice(row) {
  return {
    id: row.id,
    name: row.name,
    created_by: row.created_by,
    created_at: row.created_at,
    last_seen_at: row.last_seen_at,
    revoked_at: row.revoked_at,
  };
}

function mediaUrl(item, name) {
  const v = item.ready_at ? `?v=${item.ready_at}` : '';
  return `/media/${encodeURIComponent(item.id)}/${name}${v}`;
}

function publicItem(row, renditions) {
  const byName = {};
  for (const r of renditions) {
    byName[r.name] = { url: mediaUrl(row, r.name), mime: r.mime, width: r.width, height: r.height, bytes: r.bytes };
  }
  return {
    id: row.id,
    kind: row.kind,
    caption: row.caption,
    batch_id: row.batch_id,
    status: row.status,
    error: row.error,
    width: row.width,
    height: row.height,
    duration_ms: row.duration_ms,
    original_mime: row.original_mime,
    original_bytes: row.original_bytes,
    created_at: row.created_at,
    ready_at: row.ready_at,
    hidden_at: row.hidden_at,
    user: { id: row.user_id, name: row.user_name, color: row.user_color, status: row.user_status },
    renditions: byName,
  };
}

function listPresets(db) {
  return db
    .prepare('SELECT id, text, sort, active, created_at FROM presets ORDER BY sort, created_at, id')
    .all();
}

// ---------------------------------------------------------------------------
// Routes

export default async function adminRoutes(app, { config, db }) {
  app.addHook('onRequest', async (request, reply) => {
    reply.header('cache-control', 'no-store');
  });
  app.addHook('preHandler', requireAdmin);

  const log = (request, action, target, detail = null) =>
    logAdmin(db, { userId: request.user.id, action, target, detail });

  // --- People and invites --------------------------------------------------

  app.get('/api/admin/people', async () => {
    const people = db
      .prepare(
        `SELECT u.*,
           (SELECT MAX(s.last_seen_at) FROM sessions s WHERE s.user_id = u.id) AS last_seen_at,
           (SELECT COUNT(*) FROM items i WHERE i.user_id = u.id) AS item_count,
           (SELECT COUNT(*) FROM passkeys p WHERE p.user_id = u.id) AS passkey_count,
           (SELECT COUNT(*) FROM push_subscriptions ps WHERE ps.user_id = u.id) AS push_count
         FROM users u
         ORDER BY u.status = 'removed', u.name COLLATE NOCASE, u.id`,
      )
      .all()
      .map((row) => ({
        ...publicUser(row),
        last_seen_at: row.last_seen_at,
        item_count: row.item_count,
        passkey_count: row.passkey_count,
        push_count: row.push_count,
      }));
    const invites = db
      .prepare(
        `SELECT * FROM invites
         WHERE used_at IS NULL AND revoked_at IS NULL AND expires_at > ?
         ORDER BY created_at DESC`,
      )
      .all(Date.now())
      .map(publicInvite);
    return { people, invites };
  });

  app.post(
    '/api/admin/invites',
    { config: { rateLimit: { max: 60, timeWindow: '1 hour' } } },
    async (request, reply) => {
      const body = bodyOf(request);
      const name = cleanName(body.name);
      const email = cleanEmail(body.email);
      const role = cleanRole(body.role);
      const send = body.send === true;
      if (send && !email) {
        throw bad('email_required', 'Add their email so we can send the invite, or share the link yourself.');
      }

      if (email) {
        const existing = db.prepare('SELECT name, status FROM users WHERE email = ?').get(email);
        if (existing?.status === 'active') {
          throw httpError(409, 'already_member', `${existing.name} is already in the family with that email.`);
        }
        if (existing?.status === 'removed') {
          throw httpError(409, 'removed_member', `${existing.name} was removed. Restore them on the People page instead.`);
        }
      }

      const token = randomToken(32);
      const url = `${config.publicUrl}/join/${token}`;
      const now = Date.now();

      // Send first, so a failed email leaves nothing half-made behind.
      let sentAt = null;
      if (send) {
        try {
          await sendEmail(config, { to: email, ...inviteEmail({ name, inviterName: request.user.name, joinUrl: url }) });
          sentAt = Date.now();
        } catch (err) {
          request.log.warn({ err }, 'Invite email failed');
          // 424, not 502: 5xx bodies are always the generic sentence, and Ben needs this one.
          throw httpError(
            424,
            'email_failed',
            "We couldn't send the invite email just now. Try again, or untick “Email the invite” and send the link yourself.",
          );
        }
      }

      const invite = {
        id: newId(now),
        token_hash: sha256(token),
        created_by: request.user.id,
        name,
        email,
        role,
        sent_at: sentAt,
        expires_at: now + INVITE_LIFE_MS,
        used_at: null,
        used_by: null,
        revoked_at: null,
        created_at: now,
      };
      db.transaction(() => {
        // A new invite to the same address replaces any older open one.
        if (email) {
          db.prepare(
            'UPDATE invites SET revoked_at = ? WHERE email = ? AND used_at IS NULL AND revoked_at IS NULL',
          ).run(now, email);
        }
        db.prepare(
          `INSERT INTO invites (id, token_hash, created_by, name, email, role, sent_at, expires_at, used_at, used_by, revoked_at, created_at)
           VALUES (@id, @token_hash, @created_by, @name, @email, @role, @sent_at, @expires_at, @used_at, @used_by, @revoked_at, @created_at)`,
        ).run(invite);
        log(request, 'invite.create', invite.id, { name, email, role, sent: Boolean(sentAt) });
      })();

      reply.code(201);
      return { invite: publicInvite(invite), url, sent: Boolean(sentAt) };
    },
  );

  app.delete('/api/admin/invites/:id', async (request) => {
    const id = idParam(request, 'invite');
    const invite = db.prepare('SELECT * FROM invites WHERE id = ?').get(id);
    if (!invite) throw httpError(404, 'not_found', "We couldn't find that invite.");
    if (invite.used_at) throw httpError(409, 'invite_used', 'That invite was already used, so there is nothing to cancel.');
    if (!invite.revoked_at) {
      db.prepare('UPDATE invites SET revoked_at = ? WHERE id = ?').run(Date.now(), id);
      log(request, 'invite.revoke', id, { email: invite.email });
    }
    return { invite: publicInvite(db.prepare('SELECT * FROM invites WHERE id = ?').get(id)) };
  });

  app.post('/api/admin/people/:id/remove', async (request) => {
    const id = idParam(request, 'person');
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
    if (!user) throw httpError(404, 'not_found', "We couldn't find that person.");
    if (user.id === request.user.id) {
      throw bad('cannot_remove_self', "You can't remove yourself. Ask another admin to do it.");
    }
    if (user.status !== 'removed') {
      const now = Date.now();
      db.transaction(() => {
        db.prepare("UPDATE users SET status = 'removed', removed_at = ? WHERE id = ?").run(now, id);
        const sessions = revokeUserSessions(db, id);
        const passkeys = db.prepare('DELETE FROM passkeys WHERE user_id = ?').run(id).changes;
        const push = db.prepare('DELETE FROM push_subscriptions WHERE user_id = ?').run(id).changes;
        db.prepare('DELETE FROM webauthn_challenges WHERE user_id = ?').run(id);
        db.prepare('DELETE FROM login_codes WHERE user_id = ? AND used_at IS NULL').run(id);
        // An old invite link must not let them back in.
        db.prepare(
          'UPDATE invites SET revoked_at = ? WHERE email = ? AND used_at IS NULL AND revoked_at IS NULL',
        ).run(now, user.email);
        log(request, 'person.remove', id, { name: user.name, sessions, passkeys, push });
      })();
    }
    return { user: publicUser(db.prepare('SELECT * FROM users WHERE id = ?').get(id)) };
  });

  app.post('/api/admin/people/:id/restore', async (request) => {
    const id = idParam(request, 'person');
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
    if (!user) throw httpError(404, 'not_found', "We couldn't find that person.");
    if (user.status === 'removed') {
      // They sign in again with an email code; someone who never signed in stays pending.
      const status = user.activated_at ? 'active' : 'pending';
      db.prepare('UPDATE users SET status = ?, removed_at = NULL WHERE id = ?').run(status, id);
      log(request, 'person.restore', id, { name: user.name });
    }
    return { user: publicUser(db.prepare('SELECT * FROM users WHERE id = ?').get(id)) };
  });

  // --- Uploads ---------------------------------------------------------------

  app.get('/api/admin/items', async (request) => {
    const { status, before } = request.query;
    const limit = Math.min(Math.max(Number.parseInt(request.query.limit, 10) || 50, 1), 100);
    const where = [];
    const params = [];
    if (status) {
      if (!ITEM_STATUSES.has(status)) throw bad('bad_status', 'Choose live, getting ready, failed or hidden.');
      where.push('i.status = ?');
      params.push(status);
    }
    if (before) {
      if (!isId(before)) throw bad('bad_cursor', "That page link didn't look right. Please reload.");
      where.push('i.id < ?');
      params.push(before);
    }
    const rows = db
      .prepare(
        `SELECT i.*, u.name AS user_name, u.color AS user_color, u.status AS user_status
         FROM items i JOIN users u ON u.id = i.user_id
         ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
         ORDER BY i.id DESC LIMIT ?`,
      )
      .all(...params, limit);

    const renditions = new Map(rows.map((r) => [r.id, []]));
    if (rows.length) {
      const ids = rows.map((r) => r.id);
      for (const r of db
        .prepare(`SELECT ${RENDITION_FIELDS} FROM renditions WHERE item_id IN (${ids.map(() => '?').join(',')})`)
        .all(...ids)) {
        renditions.get(r.item_id).push(r);
      }
    }
    const items = rows.map((row) => publicItem(row, renditions.get(row.id)));
    return { items, next_before: items.length === limit ? items.at(-1).id : null };
  });

  function findItem(id) {
    const item = db.prepare('SELECT id, status, user_id FROM items WHERE id = ?').get(id);
    if (!item) throw httpError(404, 'not_found', "We couldn't find that photo or video.");
    return item;
  }

  app.post('/api/admin/items/:id/hide', async (request) => {
    const id = idParam(request, 'photo or video');
    const item = findItem(id);
    if (item.status === 'ready') {
      db.transaction(() => {
        db.prepare("UPDATE items SET status = 'hidden', hidden_at = ? WHERE id = ?").run(Date.now(), id);
        publish(db, 'item.removed', { item_id: id });
        log(request, 'item.hide', id);
      })();
    } else if (item.status !== 'hidden') {
      throw httpError(409, 'not_live', "That one isn't showing yet, so there's nothing to hide. You can delete it instead.");
    }
    return { item: { id, status: 'hidden' } };
  });

  app.post('/api/admin/items/:id/unhide', async (request) => {
    const id = idParam(request, 'photo or video');
    const item = findItem(id);
    if (item.status === 'hidden') {
      db.transaction(() => {
        db.prepare("UPDATE items SET status = 'ready', hidden_at = NULL WHERE id = ?").run(id);
        publish(db, 'item.ready', { item_id: id, user_id: item.user_id });
        log(request, 'item.unhide', id);
      })();
    } else if (item.status !== 'ready') {
      throw httpError(409, 'not_hidden', "That one isn't hidden.");
    }
    return { item: { id, status: 'ready' } };
  });

  app.delete('/api/admin/items/:id', async (request) => {
    const id = idParam(request, 'photo or video');
    const item = findItem(id);
    await deleteItem(db, app.storage, id, { log: request.log });
    publish(db, 'item.removed', { item_id: id });
    log(request, 'item.delete', id, { owner: item.user_id, status: item.status });
    return { deleted: true };
  });

  // --- Grandma's frame ---------------------------------------------------------

  app.get('/api/admin/devices', async () => {
    const devices = db
      .prepare('SELECT * FROM devices ORDER BY revoked_at IS NOT NULL, created_at DESC')
      .all()
      .map(publicDevice);
    return { devices };
  });

  app.post('/api/admin/devices', async (request, reply) => {
    const body = bodyOf(request);
    const name =
      body.name === undefined || body.name === '' ? "Grandma's frame" : cleanName(body.name, { what: 'a name', max: 60 });
    const { device, url } = pairDevice(db, { name, createdBy: request.user.id, publicUrl: config.publicUrl });
    log(request, 'device.pair', device.id, { name });
    reply.code(201);
    return { device, url };
  });

  function findDevice(id) {
    const device = db.prepare('SELECT * FROM devices WHERE id = ?').get(id);
    if (!device) throw httpError(404, 'not_found', "We couldn't find that frame.");
    return device;
  }

  app.post('/api/admin/devices/:id/revoke', async (request) => {
    const id = idParam(request, 'frame');
    const device = findDevice(id);
    if (!device.revoked_at) {
      db.transaction(() => {
        db.prepare('UPDATE devices SET revoked_at = ? WHERE id = ?').run(Date.now(), id);
        const sessions = revokeDeviceSessions(db, id);
        log(request, 'device.revoke', id, { name: device.name, sessions });
      })();
    }
    return { device: publicDevice(findDevice(id)) };
  });

  app.post('/api/admin/devices/:id/reload', async (request) => {
    const id = idParam(request, 'frame');
    const device = findDevice(id);
    if (device.revoked_at) throw httpError(409, 'device_revoked', 'That frame is unpaired. Pair it again first.');
    const eventId = publish(db, 'frame.reload', {}, `device:${id}`);
    log(request, 'device.reload', id);
    return { sent: true, event_id: eventId };
  });

  // --- Preset messages ---------------------------------------------------------

  app.get('/api/admin/presets', async () => ({ presets: listPresets(db) }));

  // The full list, in order. Presets left out are deleted, unless Grandma has
  // sent them before: those are turned off instead, so her feed and any tap still
  // queued on an offline frame keep working.
  app.put('/api/admin/presets', async (request) => {
    const input = bodyOf(request).presets;
    if (!Array.isArray(input) || input.length === 0) throw bad('presets_required', 'Add at least one message.');
    if (input.length > MAX_PRESETS) throw bad('too_many_presets', `Keep the list to ${MAX_PRESETS} messages or fewer.`);

    const known = new Set(db.prepare('SELECT id FROM presets').all().map((r) => r.id));
    const seen = new Set();
    const presets = input.map((p) => {
      if (!p || typeof p !== 'object') throw bad('bad_preset', "One of the messages didn't look right.");
      const text = typeof p.text === 'string' ? p.text.trim().replace(/\s+/g, ' ') : '';
      if (!text) throw bad('preset_empty', 'Each message needs some words.');
      if (text.length > MAX_PRESET_LENGTH) {
        throw bad('preset_too_long', `“${text.slice(0, 20)}…” is too long. Keep messages under ${MAX_PRESET_LENGTH} letters.`);
      }
      const id = p.id ?? null;
      if (id !== null) {
        if (!known.has(id)) throw bad('unknown_preset', 'One of those messages no longer exists. Please reload.');
        if (seen.has(id)) throw bad('duplicate_preset', 'The same message is in the list twice. Please reload.');
        seen.add(id);
      }
      const active = p.active === undefined ? true : p.active === true || p.active === 1;
      return { id, text, active };
    });
    const activeCount = presets.filter((p) => p.active).length;
    if (activeCount === 0) throw bad('no_active_presets', 'Turn on at least one message so Grandma has something to send.');
    if (activeCount > MAX_ACTIVE_PRESETS) {
      throw bad('too_many_active', `Grandma's screen fits ${MAX_ACTIVE_PRESETS} messages. Turn some off first.`);
    }

    db.transaction(() => {
      const now = Date.now();
      const update = db.prepare('UPDATE presets SET text = ?, sort = ?, active = ? WHERE id = ?');
      const insert = db.prepare('INSERT INTO presets (id, text, sort, active, created_at) VALUES (?, ?, ?, ?, ?)');
      presets.forEach((p, i) => {
        if (p.id) update.run(p.text, i + 1, p.active ? 1 : 0, p.id);
        else insert.run(newId(now), p.text, i + 1, p.active ? 1 : 0, now);
      });
      const used = db.prepare('SELECT 1 FROM grandma_events WHERE preset_id = ? LIMIT 1');
      let sort = presets.length;
      for (const id of known) {
        if (seen.has(id)) continue;
        if (used.get(id)) db.prepare('UPDATE presets SET active = 0, sort = ? WHERE id = ?').run(++sort, id);
        else db.prepare('DELETE FROM presets WHERE id = ?').run(id);
      }
      publish(db, 'settings.changed', { keys: ['presets'] });
      log(request, 'presets.update', null, { texts: presets.filter((p) => p.active).map((p) => p.text) });
    })();
    return { presets: listPresets(db) };
  });

  // --- Settings ----------------------------------------------------------------

  app.get('/api/admin/settings', async () => ({ settings: getSettings(db, [...EDITABLE_SETTING_KEYS]) }));

  app.put('/api/admin/settings', async (request) => {
    const changes = validateSettings(bodyOf(request));
    db.transaction(() => {
      setSettings(db, changes);
      publish(db, 'settings.changed', { keys: Object.keys(changes) });
      log(request, 'settings.update', null, changes);
    })();
    return { settings: getSettings(db, [...EDITABLE_SETTING_KEYS]) };
  });

  // --- Health --------------------------------------------------------------------

  app.get('/api/admin/health', async (request) => {
    const queue = { image: 0, video: 0, voice: 0 };
    let running = 0;
    for (const row of db
      .prepare("SELECT kind, status, COUNT(*) AS n FROM jobs WHERE status IN ('queued', 'running') GROUP BY kind, status")
      .all()) {
      queue[row.kind] = (queue[row.kind] ?? 0) + row.n;
      if (row.status === 'running') running += row.n;
    }
    const recentFailures = db
      .prepare(
        "SELECT id, kind, ref_id, attempts, error, updated_at FROM jobs WHERE status = 'failed' ORDER BY updated_at DESC LIMIT 10",
      )
      .all();
    const failedJobs = db.prepare("SELECT COUNT(*) AS n FROM jobs WHERE status = 'failed'").get().n;

    const items = { processing: 0, ready: 0, failed: 0, hidden: 0 };
    for (const row of db.prepare('SELECT status, COUNT(*) AS n FROM items GROUP BY status').all()) items[row.status] = row.n;

    const frames = db
      .prepare('SELECT id, name, last_seen_at FROM devices WHERE revoked_at IS NULL ORDER BY last_seen_at DESC')
      .all();
    const frameLastSeen = frames.reduce((max, f) => Math.max(max, f.last_seen_at ?? 0), 0) || null;

    let disk = { free: null, total: null };
    try {
      const stats = await fs.statfs(config.mediaDir);
      disk = { free: stats.bavail * stats.bsize, total: stats.blocks * stats.bsize };
    } catch (err) {
      request.log.warn({ err }, 'Could not read free disk space');
    }

    return {
      queue_depth: Object.values(queue).reduce((a, b) => a + b, 0),
      running,
      queue,
      failed_jobs: failedJobs,
      recent_failures: recentFailures,
      items,
      disk_free_bytes: disk.free,
      disk_total_bytes: disk.total,
      frame_last_seen: frameLastSeen,
      frames,
      worker_last_seen: getSetting(db, 'worker_last_seen', null),
      now: Date.now(),
    };
  });
}
