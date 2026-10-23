// Admin helpers shared by the admin routes and the CLIs in server/scripts/:
// checking a name or email, pairing a frame, making the first admin, deleting
// an item with its files, and the admin_log.

import { httpError } from './guards.js';
import { newId } from './ids.js';
import { randomToken, sha256 } from './tokens.js';

const MAX_NAME_LENGTH = 80;

function bad(code, message) {
  return httpError(400, code, message);
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

export function publicDevice(row) {
  return {
    id: row.id,
    name: row.name,
    created_by: row.created_by,
    created_at: row.created_at,
    last_seen_at: row.last_seen_at,
    revoked_at: row.revoked_at,
  };
}
