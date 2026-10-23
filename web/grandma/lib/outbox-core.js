// The outbox's state machine, pure so it can be tested without IndexedDB.
//
//   pending ──send──▶ sending ──ok / 409──▶ (removed)
//      ▲                 │
//      └──network, 5xx, 401, 429 (retry at the next 30 s tick or 'online')
//                        └──400/404/410/413/422──▶ failed (kept; counted in the heartbeat for Ben)
//
// Every entry carries a client_id the server is idempotent on, so sending one
// twice (a reply lost to a dropped connection) is harmless.

export const RETRY_MS = 30_000;
const PERMANENT = new Set([400, 404, 410, 413, 422]);

export function createEntry({ kind, payload, clientId, now }) {
  return {
    client_id: clientId,
    kind,
    payload,
    status: 'pending',
    attempts: 0,
    created_at: now,
    next_at: now,
    last_error: null,
  };
}

/** 'done' | 'retry' | 'failed' for an HTTP status (0 = the request never got an answer). */
export function classify(status) {
  if ((status >= 200 && status < 300) || status === 409) return 'done';
  if (PERMANENT.has(status)) return 'failed';
  return 'retry';
}

/** Pending entries whose time has come (all pending ones when forced), oldest first. */
export function due(entries, now, { force = false } = {}) {
  return entries
    .filter((e) => e.status === 'pending' && (force || e.next_at <= now))
    .sort((a, b) => a.created_at - b.created_at);
}

export function markSending(entry, now) {
  return { ...entry, status: 'sending', attempts: entry.attempts + 1, last_try_at: now };
}

/** The entry after a send; null means it is finished and leaves the outbox. */
export function applyResult(entry, { status, error }, now) {
  const outcome = classify(status);
  if (outcome === 'done') return null;
  const last_error = error ?? `HTTP ${status}`;
  if (outcome === 'failed') return { ...entry, status: 'failed', last_error };
  return { ...entry, status: 'pending', next_at: now + RETRY_MS, last_error };
}

/** After a reload, anything caught mid-send goes back to pending (the server dedupes). */
export function recover(entries) {
  return entries.filter((e) => e.status === 'sending').map((e) => ({ ...e, status: 'pending' }));
}

export function summarize(entries) {
  return {
    pending: entries.filter((e) => e.status !== 'failed').length,
    failed: entries.filter((e) => e.status === 'failed').length,
  };
}
