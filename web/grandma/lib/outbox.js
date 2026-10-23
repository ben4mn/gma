// The frame's outbox: reactions, presets, voice notes and "seen" marks wait here
// (IndexedDB) until the server has them. Grandma's screen has already said
// "Sent"; a failure is never shown to her (the heartbeat reports counts to admin).
import { createEntry, due, markSending, applyResult, recover, summarize, RETRY_MS } from './outbox-core.js';

export function createOutbox({ store, send, now = Date.now, newId = () => crypto.randomUUID() }) {
  let running = null; // the pass in progress
  let queued = null;  // the one pass waiting behind it
  let timer = null;
  let counts = { pending: 0, failed: 0 };

  async function refreshCounts() {
    counts = summarize(await store.getAll());
    return counts;
  }

  async function add(kind, payload) {
    const entry = createEntry({ kind, payload, clientId: newId(), now: now() });
    await store.put(entry);
    flush().catch(() => {});
    return entry;
  }

  async function sendOne(entry) {
    const sending = markSending(entry, now());
    await store.put(sending);
    let result;
    try {
      result = await send(sending);
    } catch (err) {
      result = { status: 0, error: String(err?.message ?? err) };
    }
    const next = applyResult(sending, result, now());
    if (next) await store.put(next);
    else await store.delete(entry.client_id);
  }

  // "Seen" marks are batched into one request; everything else goes one by one.
  async function sendSeen(entries) {
    if (!entries.length) return;
    const item_ids = [...new Set(entries.flatMap((e) => e.payload.item_ids))];
    const merged = { ...entries[0], payload: { item_ids } };
    const sending = markSending(merged, now());
    let result;
    try {
      result = await send(sending);
    } catch (err) {
      result = { status: 0, error: String(err?.message ?? err) };
    }
    const next = applyResult(sending, result, now());
    for (const e of entries) {
      if (next) await store.put({ ...next, client_id: e.client_id, payload: e.payload });
      else await store.delete(e.client_id);
    }
  }

  async function runFlush(force) {
    const entries = await store.getAll();
    for (const e of recover(entries)) await store.put(e);
    const ready = due(await store.getAll(), now(), { force });
    await sendSeen(ready.filter((e) => e.kind === 'seen'));
    for (const entry of ready.filter((e) => e.kind !== 'seen')) await sendOne(entry);
    await refreshCounts();
  }

  /**
   * Send what is due. One pass runs at a time; a call made during a pass queues
   * exactly one more pass (so an entry added mid-send goes out right after) and
   * resolves when that pass ends. A forced pass ignores the retry clock.
   */
  function flush({ force = false } = {}) {
    if (queued) {
      queued.force = queued.force || force;
      return queued.promise;
    }
    if (!running) return beginPass(force);
    const next = { force };
    next.promise = running.catch(() => {}).then(() => {
      queued = null;
      return beginPass(next.force);
    });
    queued = next;
    return next.promise;
  }

  function beginPass(force) {
    running = runFlush(force).finally(() => { running = null; });
    return running;
  }

  function start(target = globalThis) {
    target.addEventListener?.('online', () => flush({ force: true }).catch(() => {}));
    timer = setInterval(() => flush({ force: true }).catch(() => {}), RETRY_MS);
    return flush({ force: true }).catch(() => {});
  }

  function stop() { clearInterval(timer); }

  return { add, flush, start, stop, refreshCounts, get counts() { return counts; } };
}

/** An in-memory store (fixture mode and tests). */
export function memoryStore() {
  const rows = new Map();
  return {
    async getAll() { return [...rows.values()].map((r) => ({ ...r })); },
    async put(entry) { rows.set(entry.client_id, { ...entry }); },
    async delete(id) { rows.delete(id); },
  };
}

/** The IndexedDB store. Blobs (voice notes) are stored as they are. */
export function idbStore(dbName = 'gma-frame', storeName = 'outbox') {
  const ready = new Promise((resolve, reject) => {
    const req = indexedDB.open(dbName, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(storeName, { keyPath: 'client_id' });
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  async function run(mode, fn) {
    const db = await ready;
    return new Promise((resolve, reject) => {
      const tx = db.transaction(storeName, mode);
      const req = fn(tx.objectStore(storeName));
      tx.oncomplete = () => resolve(req?.result);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  }
  return {
    getAll: () => run('readonly', (s) => s.getAll()),
    put: (entry) => run('readwrite', (s) => s.put(entry)),
    delete: (id) => run('readwrite', (s) => s.delete(id)),
  };
}
