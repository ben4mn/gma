// openDb(path) opens the SQLite database with the app's pragmas and runs any
// migrations that haven't been applied yet. The app and the worker both call
// it at start; migrations run inside an IMMEDIATE transaction, so if both
// start at once only one applies each file.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';

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
    const apply = db.transaction(() => {
      if (isApplied.get(name)) return false;
      db.exec(sql);
      record.run(name, Date.now());
      return true;
    });
    try {
      if (apply.immediate()) applied.push(name);
    } catch (err) {
      err.message = `Migration ${name} failed: ${err.message}`;
      throw err;
    }
  }
  return applied;
}
