import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeTestApp } from './helpers/index.js';
import { BACKOFF_MS, claim, complete, enqueue, fail, release, requeueStale, backoffFor } from '../src/jobs/queue.js';
import { startRunner } from '../src/jobs/runner.js';
import { getSetting } from '../src/lib/settings.js';

const job = (db, id) => db.prepare('SELECT * FROM jobs WHERE id = ?').get(id);

test('claim takes the oldest due job once, and only of the asked kinds', async (t) => {
  const ctx = await makeTestApp();
  t.after(ctx.cleanup);
  const { db } = ctx;
  const later = enqueue(db, { kind: 'image', refId: 'a', runAfter: Date.now() + 60_000, now: 1 });
  const first = enqueue(db, { kind: 'image', refId: 'b', now: 2 });
  const video = enqueue(db, { kind: 'video', refId: 'c', now: 3 });

  const claimed = claim(db, { workerId: 'w1', kinds: ['image'] });
  assert.equal(claimed.id, first);
  assert.equal(claimed.status, 'running');
  assert.equal(claimed.attempts, 1);
  assert.equal(claimed.locked_by, 'w1');
  assert.equal(claim(db, { workerId: 'w2', kinds: ['image'] }), null, 'the future job is not due and the first is taken');
  assert.equal(claim(db, { workerId: 'w2', kinds: ['video'] }).id, video);
  assert.equal(job(db, later).status, 'queued');

  complete(db, first);
  assert.equal(job(db, first).status, 'done');
  assert.equal(job(db, first).locked_by, null);
});

test('failures back off 30 s, 2 min, then give up after 3 attempts', async (t) => {
  const ctx = await makeTestApp();
  t.after(ctx.cleanup);
  const { db } = ctx;
  const id = enqueue(db, { kind: 'image', refId: 'x' });
  let now = Date.now();
  for (const [attempt, expected] of [[1, 'queued'], [2, 'queued'], [3, 'failed']]) {
    const claimed = claim(db, { workerId: 'w', now });
    assert.equal(claimed.attempts, attempt);
    assert.equal(fail(db, claimed, new Error('boom'), { now }), expected);
    if (expected === 'queued') {
      assert.equal(job(db, id).run_after, now + BACKOFF_MS[attempt - 1]);
      assert.equal(claim(db, { workerId: 'w', now: now + BACKOFF_MS[attempt - 1] - 1 }), null, 'not before the backoff');
      now += BACKOFF_MS[attempt - 1];
    }
  }
  assert.equal(job(db, id).error, 'boom');
  assert.deepEqual([1, 2, 3].map(backoffFor), [30_000, 120_000, 600_000]);
});

test('a permanent error fails at once; release puts a job back without spending an attempt', async (t) => {
  const ctx = await makeTestApp();
  t.after(ctx.cleanup);
  const { db } = ctx;
  const a = enqueue(db, { kind: 'video', refId: 'a' });
  assert.equal(fail(db, claim(db, { workerId: 'w' }), Object.assign(new Error('too long'), { permanent: true })), 'failed');
  assert.equal(job(db, a).status, 'failed');

  const b = enqueue(db, { kind: 'video', refId: 'b' });
  claim(db, { workerId: 'w' });
  release(db, b);
  assert.equal(job(db, b).status, 'queued');
  assert.equal(job(db, b).attempts, 0);
});

test('jobs locked for longer than any job can run (2 h) are requeued by the sweep', async (t) => {
  const ctx = await makeTestApp();
  t.after(ctx.cleanup);
  const { db } = ctx;
  const now = Date.now();
  const stale = enqueue(db, { kind: 'image', refId: 's', runAfter: 0, now: 1 });
  const fresh = enqueue(db, { kind: 'image', refId: 'f', runAfter: 0, now: 2 });
  claim(db, { workerId: 'dead', now: now - 121 * 60_000 });
  claim(db, { workerId: 'alive', now: now - 60_000 });
  assert.equal(requeueStale(db, { now }), 1);
  assert.equal(job(db, stale).status, 'queued');
  assert.equal(job(db, fresh).status, 'running');
});

function deferred() {
  let resolve;
  const promise = new Promise((r) => (resolve = r));
  return { promise, resolve };
}

test('the runner respects per-kind concurrency, writes its heartbeat and records final failures', async (t) => {
  const ctx = await makeTestApp();
  t.after(ctx.cleanup);
  const { db } = ctx;
  const gate = deferred();
  const started = [];
  const failed = [];
  const handler = {
    async run(_ctx, j) {
      started.push(j.ref_id);
      if (j.ref_id === 'bad') throw Object.assign(new Error('nope'), { permanent: true });
      await gate.promise;
    },
    onFailed(_ctx, j, err) {
      failed.push([j.ref_id, err.message]);
    },
  };
  for (const ref of ['i1', 'i2', 'i3']) enqueue(db, { kind: 'image', refId: ref });
  for (const ref of ['v1', 'v2']) enqueue(db, { kind: 'video', refId: ref });
  enqueue(db, { kind: 'voice', refId: 'bad' });

  const runner = startRunner({ config: ctx.config, db, storage: ctx.app.storage, handlers: { image: handler, video: handler, voice: handler }, pollMs: 60_000 });
  t.after(() => runner.stop());
  runner.tick();
  assert.deepEqual(runner.running, { image: 2, video: 1, voice: 1 });
  assert.ok(getSetting(db, 'worker_last_seen') > Date.now() - 5000);

  gate.resolve();
  await runner.drain();
  await new Promise((r) => setImmediate(r));
  await runner.drain();
  assert.deepEqual(new Set(started), new Set(['i1', 'i2', 'i3', 'v1', 'v2', 'bad']));
  assert.deepEqual(failed, [['bad', 'nope']]);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM jobs WHERE status = 'done'").get().n, 5);
});

test('stop() waits for running jobs, then cancels and requeues what is still going', async (t) => {
  const ctx = await makeTestApp();
  t.after(ctx.cleanup);
  const { db } = ctx;
  const handler = {
    run: (jobCtx) =>
      new Promise((resolve, reject) => {
        jobCtx.signal.addEventListener('abort', () => reject(new Error('cancelled')));
      }),
  };
  const id = enqueue(db, { kind: 'video', refId: 'long' });
  const runner = startRunner({ config: ctx.config, db, storage: ctx.app.storage, handlers: { video: handler }, pollMs: 60_000, graceMs: 50 });
  runner.tick();
  assert.equal(job(db, id).status, 'running');
  await runner.stop();
  const after = job(db, id);
  assert.equal(after.status, 'queued');
  assert.equal(after.attempts, 0, 'the interrupted attempt is not counted');
  assert.equal(runner.tick(), 0, 'a stopped runner claims nothing');
});
