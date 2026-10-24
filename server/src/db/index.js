// openDb(path) opens the SQLite database with the app's pragmas and runs any
// migrations that haven't been applied yet. The app and the worker both call
// it at start; migrations run inside an IMMEDIATE transaction, so if both
// start at once only one applies each file.

import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { immediate } from '../lib/tx.js';

const MIGRATIONS_DIR = fileURLToPath(new URL('./migrations/', import.meta.url));

export function openDb(dbPath, { migrate: runMigrations = true, migrationsDir = MIGRATIONS_DIR } = {}) {
  if (dbPath !== ':memory:') fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  try {
    db.pragma('journal_mode = WAL');
    db.pragma('busy_timeout = 5000');
    db.pragma('foreign_keys = ON');
    db.pragma('synchronous = NORMAL');
    if (runMigrations) migrate(db, migrationsDir);
  } catch (err) {
    db.close();
    throw err;
  }
  return db;
}

export function listMigrations(migrationsDir = MIGRATIONS_DIR) {
  return fs
    .readdirSync(migrationsDir)
    .filter((name) => /^\d{3,}_[\w-]+\.sql$/.test(name))
    .sort();
}

// Applies every migrations/NNN_*.sql not yet recorded in schema_migrations, in
// order. Returns the names it applied.
export function migrate(db, migrationsDir = MIGRATIONS_DIR) {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    name        TEXT PRIMARY KEY,
    applied_at  INTEGER NOT NULL
  )`);
  const applied = [];
  const isApplied = db.prepare('SELECT 1 FROM schema_migrations WHERE name = ?');
  const record = db.prepare('INSERT INTO schema_migrations (name, applied_at) VALUES (?, ?)');

  for (const name of listMigrations(migrationsDir)) {
    const sql = fs.readFileSync(path.join(migrationsDir, name), 'utf8');
    try {
      const done = immediate(db, () => {
        if (isApplied.get(name)) return false;
        db.exec(sql);
        record.run(name, Date.now());
        return true;
      });
      if (done) applied.push(name);
    } catch (err) {
      err.message = `Migration ${name} failed: ${err.message}`;
      throw err;
    }
  }
  return applied;
}

// The migrations not yet recorded in `db`.
function pendingMigrations(db, migrationsDir) {
  const hasTable = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'").get();
  const applied = new Set(hasTable ? db.prepare('SELECT name FROM schema_migrations').pluck().all() : []);
  return listMigrations(migrationsDir).filter((name) => !applied.has(name));
}

function stamp(ms) {
  return new Date(ms).toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
}

// Before an upgrade migrates the live database (OPS-11): when an existing
// database has migrations pending, a consistent copy is made with SQLite's
// backup API at <backupsDir>/pre-<first pending>-<UTC time>.sqlite. The nightly
// pruning leaves these alone, so a logically wrong migration can be undone
// with the state of a minute ago instead of last night's snapshot. One per
// migration: if a copy before this migration exists already (the app and the
// worker start together, or a migration failed and rolled back), it is kept
// and no second one is made. → the copy's path, or null when none was needed.
export async function snapshotBeforeMigrations({ dbPath, backupsDir, migrationsDir = MIGRATIONS_DIR, now = Date.now() }) {
  if (dbPath === ':memory:' || !fs.existsSync(dbPath)) return null;
  const db = new Database(dbPath, { fileMustExist: true });
  try {
    db.pragma('busy_timeout = 5000');
    const hasTables = db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table'").get().n > 0;
    const pending = hasTables ? pendingMigrations(db, migrationsDir) : [];
    if (!pending.length) return null;
    const stem = pending[0].replace(/\.sql$/, '');
    fs.mkdirSync(backupsDir, { recursive: true });
    if (fs.readdirSync(backupsDir).some((name) => name.startsWith(`pre-${stem}-`) && name.endsWith('.sqlite'))) return null;
    const name = `pre-${stem}-${stamp(now)}.sqlite`;
    const finalPath = path.join(backupsDir, name);
    // ".gma-…tmp-" so the nightly pruning clears one a crash left behind.
    const tempPath = path.join(backupsDir, `.gma-${name}.tmp-${process.pid}-${randomBytes(4).toString('hex')}`);
    try {
      await db.backup(tempPath);
      fs.renameSync(tempPath, finalPath);
    } catch (err) {
      fs.rmSync(tempPath, { force: true });
      throw err;
    }
    return finalPath;
  } finally {
    db.close();
  }
}
