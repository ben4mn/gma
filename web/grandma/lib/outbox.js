// The frame's outbox: reactions, presets, voice notes and "seen" marks wait here
// (IndexedDB) until the server has them. Grandma's screen has already said
// "Sent"; a failure is never shown to her (the heartbeat reports counts to admin).
import { createEntry, due, markSending, applyResult, recover, summarize, RETRY_MS } from './outbox-core.js';

export function createOutbox({ store, send, now = Date.now, newId = () => crypto.randomUUID() }) {
  // Entries being sent right now, by client_id. Each send stands alone: a voice
  // upload stalled on bad Wi-Fi (the request times out after a while, see api.js)
  // never holds the reactions and messages tapped after it.
  const inFlight = new Map();
  let recovered = false;
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

  async function attempt(entry) {
    try {
      return await send(entry);
    } catch (err) {
      return { status: 0, error: String(err?.message ?? err) };
    }
  }

  async function sendOne(entry) {
    const sending = markSending(entry, now());
    await store.put(sending);
    const next = applyResult(sending, await attempt(sending), now());
    if (next) await store.put(next);
    else await store.delete(entry.client_id);
  }

  // "Seen" marks are batched into one request; everything else goes one by one.
  async function sendSeen(entries) {
    const item_ids = [...new Set(entries.flatMap((e) => e.payload.item_ids))];
    const sending = markSending({ ...entries[0], payload: { item_ids } }, now());
    const next = applyResult(sending, await attempt(sending), now());
    for (const e of entries) {
      if (next) await store.put({ ...next, client_id: e.client_id, payload: e.payload });
      else await store.delete(e.client_id);
    }
  }

  function track(entries, run) {
    const p = run().catch(() => {}).finally(() => { for (const e of entries) inFlight.delete(e.client_id); });
    for (const e of entries) inFlight.set(e.client_id, p);
    return p;
  }

  /**
   * Send what is due (everything pending when forced), oldest first. Entries
   * already on their way are not sent twice; the promise resolves when every
   * send it started, and every one already in flight, has had its answer.
   */
  async function flush({ force = false } = {}) {
    if (!recovered) {
      // after a reload, anything caught mid-send goes back to pending (the server dedupes)
      recovered = true;
      for (const e of recover(await store.getAll())) await store.put(e);
    }
    const ready = due(await store.getAll(), now(), { force });
    const waits = new Set(inFlight.values());
    const fresh = ready.filter((e) => !inFlight.has(e.client_id));
    const seen = fresh.filter((e) => e.kind === 'seen');
    if (seen.length) waits.add(track(seen, () => sendSeen(seen)));
    for (const entry of fresh.filter((e) => e.kind !== 'seen')) waits.add(track([entry], () => sendOne(entry)));
    await Promise.all(waits);
    await refreshCounts();
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
