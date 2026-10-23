// Key/value settings stored as JSON (night hours, time zone, worker_last_seen …).
// Defaults for the frame live in the 001 migration; DEFAULT_SETTINGS mirrors
// them so a missing row still reads sensibly.

import { immediate } from './tx.js';

export const DEFAULT_SETTINGS = Object.freeze({
  night_start: '21:00',
  night_end: '07:00',
  timezone: 'America/Chicago',
  max_video_seconds: 180,
  max_voice_seconds: 60,
});

function parse(raw, key) {
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error(`Setting "${key}" holds invalid JSON`);
  }
}

export function getSetting(db, key, fallback = DEFAULT_SETTINGS[key] ?? null) {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return row ? parse(row.value, key) : fallback;
}

export function setSetting(db, key, value) {
  if (value === undefined) throw new TypeError(`Setting "${key}" needs a value`);
  db.prepare(
    'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value',
  ).run(key, JSON.stringify(value));
}

// All settings (or just `keys`) as one object, defaults filled in.
export function getSettings(db, keys = null) {
  const rows = keys
    ? db.prepare(`SELECT key, value FROM settings WHERE key IN (${keys.map(() => '?').join(',')})`).all(...keys)
    : db.prepare('SELECT key, value FROM settings').all();
  const out = {};
  for (const key of keys ?? Object.keys(DEFAULT_SETTINGS)) {
    if (key in DEFAULT_SETTINGS) out[key] = DEFAULT_SETTINGS[key];
  }
  for (const row of rows) out[row.key] = parse(row.value, row.key);
  return out;
}

export function setSettings(db, values) {
  immediate(db, (entries) => {
    for (const [key, value] of entries) setSetting(db, key, value);
  }, Object.entries(values));
}
