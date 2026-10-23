// The jobs table as a queue. The app enqueues; the worker claims, completes
// and fails. A claim is one UPDATE … RETURNING, so two workers (or a restarted
// one) can never run the same job at once.

import { newId } from '../lib/ids.js';

export const JOB_KINDS = Object.freeze(['image', 'video', 'voice']);
export const MAX_ATTEMPTS = 3;
// Waits before attempts 2, 3, … (ARCHITECTURE.md: 30 s, 2 min, 10 min).
export const BACKOFF_MS = Object.freeze([30_000, 120_000, 600_000]);
export const STALE_LOCK_MS = 30 * 60 * 1000;

const ERROR_MAX = 2000;

function assertKind(kind) {
  if (!JOB_KINDS.includes(kind)) throw new TypeError(`Unknown job kind "${kind}"`);
}

export function backoffFor(attempts) {
  return BACKOFF_MS[Math.min(Math.max(attempts, 1), BACKOFF_MS.length) - 1];
}

export function enqueue(db, { kind, refId, runAfter = Date.now(), maxAttempts = MAX_ATTEMPTS, now = Date.now() }) {
  assertKind(kind);
  if (!refId) throw new TypeError('A job needs a ref id');
  const id = newId(now);
  db.prepare(
    `INSERT INTO jobs (id, kind, ref_id, status, attempts, max_attempts, run_after, created_at, updated_at)
     VALUES (?, ?, ?, 'queued', 0, ?, ?, ?, ?)`,
  ).run(id, kind, refId, maxAttempts, runAfter, now, now);
  return id;
}

// Claims the oldest due job of one of `kinds` (all kinds by default), or null.
export function claim(db, { workerId, kinds = JOB_KINDS, now = Date.now() }) {
  if (!kinds.length) return null;
  kinds.forEach(assertKind);
  const placeholders = kinds.map(() => '?').join(', ');
  return (
    db
      .prepare(
        `UPDATE jobs
            SET status = 'running', locked_at = ?, locked_by = ?, attempts = attempts + 1, updated_at = ?
          WHERE id = (SELECT id FROM jobs
                       WHERE status = 'queued' AND run_after <= ? AND kind IN (${placeholders})
                       ORDER BY created_at LIMIT 1)
        RETURNING *`,
      )
      .get(now, workerId, now, now, ...kinds) ?? null
  );
}

export function complete(db, jobId, { now = Date.now() } = {}) {
  db.prepare(
    `UPDATE jobs SET status = 'done', locked_at = NULL, locked_by = NULL, error = NULL, updated_at = ?
      WHERE id = ? AND status = 'running'`,
  ).run(now, jobId);
}

// Records a failed attempt. Retries with backoff while attempts remain, unless
// the error is permanent (`err.permanent`, e.g. a video that is too long).
// → 'queued' (will retry) or 'failed' (gave up).
export function fail(db, job, err, { now = Date.now() } = {}) {
  const message = String(err?.message ?? err ?? 'Unknown error').slice(0, ERROR_MAX);
  const attempts = job.attempts ?? 1;
  const retry = !err?.permanent && attempts < (job.max_attempts ?? MAX_ATTEMPTS);
  if (retry) {
    db.prepare(
      `UPDATE jobs SET status = 'queued', run_after = ?, locked_at = NULL, locked_by = NULL, error = ?, updated_at = ?
        WHERE id = ?`,
    ).run(now + backoffFor(attempts), message, now, job.id);
    return 'queued';
  }
  db.prepare(
    `UPDATE jobs SET status = 'failed', locked_at = NULL, locked_by = NULL, error = ?, updated_at = ? WHERE id = ?`,
  ).run(message, now, job.id);
  return 'failed';
}

// Puts a running job back without spending an attempt (a graceful shutdown
// interrupted it; it was not the job's fault).
export function release(db, jobId, { now = Date.now() } = {}) {
  db.prepare(
    `UPDATE jobs SET status = 'queued', attempts = MAX(attempts - 1, 0), locked_at = NULL, locked_by = NULL,
                     run_after = ?, updated_at = ?
      WHERE id = ? AND status = 'running'`,
  ).run(now, now, jobId);
}

// At boot: jobs a dead worker left running for over 30 minutes go back in the queue.
export function requeueStale(db, { olderThanMs = STALE_LOCK_MS, now = Date.now() } = {}) {
  return db
    .prepare(
      `UPDATE jobs SET status = 'queued', locked_at = NULL, locked_by = NULL, run_after = ?, updated_at = ?
        WHERE status = 'running' AND locked_at < ?`,
    )
    .run(now, now, now - olderThanMs).changes;
}

// Queued jobs for something that no longer exists (a deleted item).
export function cancelQueued(db, refId) {
  return db.prepare("DELETE FROM jobs WHERE ref_id = ? AND status = 'queued'").run(refId).changes;
}

export function queueDepth(db) {
  return db.prepare("SELECT COUNT(*) AS n FROM jobs WHERE status IN ('queued', 'running')").get().n;
}
