// Every write transaction in gma starts with BEGIN IMMEDIATE.
//
// The app and the worker are two processes on one WAL database. A deferred
// transaction that reads first and writes later fails at once with
// SQLITE_BUSY(_SNAPSHOT) when the other process commits in between, and
// busy_timeout is never consulted for that upgrade. BEGIN IMMEDIATE takes the
// write lock up front, so the other process simply waits its turn (up to
// busy_timeout). Use this for every transaction that writes, and in particular
// wherever a read decides a write.
//
//   const id = immediate(db, () => { const row = db.prepare(…).get(); …; return row.id; });

export function immediate(db, fn, ...args) {
  return db.transaction(fn).immediate(...args);
}
