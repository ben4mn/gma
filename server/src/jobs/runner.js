// The worker's job loop: startRunner({ config, db, storage, log }) → { stop() }.
//
// Every second it claims due jobs while each kind has a free slot (video 1,
// image 2, voice 1), runs them, and marks them done or failed (with backoff,
// see queue.js). At boot it requeues jobs a dead worker left running. It
// writes worker_last_seen every 15 s. stop() stops claiming, lets running jobs
// finish for a grace period, then cancels the rest and puts them back in the
// queue without spending an attempt.
//
// A job whose item or voice note was deleted meanwhile is done (there is nothing
// left to do), not failed. Once a minute the runner also checks whether the
// nightly database snapshot is due (snapshot.js).

import os from 'node:os';
import { randomBytes } from 'node:crypto';
import { createMediaTools } from '../lib/media.js';
import { setSetting } from '../lib/settings.js';
import { claim, complete, fail, release, requeueRunning, sweepStale, JOB_KINDS } from './queue.js';
import * as imageJob from './image.js';
import { snapshotIfDue } from './snapshot.js';
import * as videoJob from './video.js';
import * as voiceJob from './voice.js';

export const DEFAULT_CONCURRENCY = Object.freeze({ video: 1, image: 2, voice: 1 });
// How long a job waits after the photo drive went away under it.
export const MEDIA_RETRY_MS = 60_000;
export const SWEEP_EVERY_MS = 10 * 60_000;
export const DEFAULT_HANDLERS = Object.freeze({ image: imageJob, video: videoJob, voice: voiceJob });

const noopLog = { info() {}, warn() {}, error() {} };

export function startRunner({
  config,
  db,
  storage,
  log = noopLog,
  media = createMediaTools(),
  push = null, // tests pass { notifyGrandmaEvent }; voice.js loads lib/push.js otherwise
  handlers = DEFAULT_HANDLERS,
  concurrency = DEFAULT_CONCURRENCY,
  pollMs = 1000,
  heartbeatMs = 15_000,
  graceMs = 20_000,
  // { firstCheckMs, checkMs } for the nightly snapshot, or false to leave it off.
  snapshots = { firstCheckMs: 30_000, checkMs: 60_000 },
  workerId = `${os.hostname()}:${process.pid}:${randomBytes(3).toString('hex')}`,
  sweepMs = SWEEP_EVERY_MS,
} = {}) {
  const kinds = JOB_KINDS.filter((kind) => handlers[kind] && (concurrency[kind] ?? 0) > 0);
  const running = Object.fromEntries(kinds.map((kind) => [kind, 0]));
  const inflight = new Map(); // job id → { controller, promise }
  let stopping = false;

  // The photo drive's sentinel, checked before every claim: while it is gone the
  // worker holds every job (logging once) instead of failing them, and picks up
  // again on its own when the drive is back.
  let mediaWasMissing = false;
  function mediaMounted() {
    const ok = storage?.isMounted ? storage.isMounted() : true;
    if (!ok && !mediaWasMissing) {
      log.error('The photo drive is gone (its .gma-media file is missing), so jobs wait until it is back');
    } else if (ok && mediaWasMissing) {
      log.info('The photo drive is back; jobs carry on');
    }
    mediaWasMissing = !ok;
    return ok;
  }

  // A job that just failed for good while being reclaimed: its item or voice note is marked failed.
  async function gaveUp(job) {
    const handler = handlers[job.kind];
    const ctx = { config, db, storage, log, media, push, signal: new AbortController().signal };
    const err = Object.assign(new Error(job.error), { permanent: true });
    log.error(`${job.kind} job ${job.id} failed for good: ${job.error}`);
    try {
      await handler?.onFailed?.(ctx, job, err);
    } catch (hookErr) {
      log.error(`Could not record the failure of ${job.kind} job ${job.id}: ${hookErr.message}`);
    }
  }

  function reclaimed({ requeued, failed }, what) {
    if (requeued) log.warn(`Requeued ${requeued} job(s) ${what}`);
    return Promise.all(failed.map(gaveUp));
  }

  let reclaiming;
  try {
    reclaiming = reclaimed(requeueRunning(db), 'a stopped worker left running');
  } catch (err) {
    log.error(`Could not requeue the jobs a stopped worker left running: ${err.message}`);
    reclaiming = Promise.resolve();
  }
  function sweep() {
    try {
      reclaimed(sweepStale(db, { workerId }), 'that were stuck').catch(() => {});
    } catch (err) {
      log.error(`Could not sweep stuck jobs: ${err.message}`);
    }
  }

  function beat() {
    try {
      setSetting(db, 'worker_last_seen', Date.now());
    } catch (err) {
      log.warn(`Could not write worker_last_seen: ${err.message}`);
    }
  }

  // True when the row the job is for (an item, a voice note) no longer exists.
  function refGone(handler, ctx, job) {
    try {
      return handler.isGone?.(ctx, job) === true;
    } catch {
      return false;
    }
  }

  async function runJob(job, controller) {
    const handler = handlers[job.kind];
    const ctx = { config, db, storage, log, media, push, signal: controller.signal };
    try {
      await handler.run(ctx, job);
      complete(db, job.id);
    } catch (err) {
      try {
        await settle(handler, ctx, job, controller, err);
      } catch (bookErr) {
        // Never an unhandled rejection (it would kill the worker and strand the
        // job): the job stays 'running' and the next start or sweep reclaims it.
        log.error(`Could not record how ${job.kind} job ${job.id} ended: ${bookErr.message}`);
      }
    }
  }

  async function settle(handler, ctx, job, controller, err) {
    if (stopping && controller.signal.aborted) {
      release(db, job.id);
      log.info(`Put ${job.kind} job ${job.id} back in the queue for the next start`);
      return;
    }
    if (refGone(handler, ctx, job)) {
      // Deleted while we worked on it (its files went with it): nothing left to do.
      complete(db, job.id);
      log.info(`${job.kind} job ${job.id}: ${job.ref_id} was deleted, so there is nothing to do`);
      return;
    }
    if (!mediaMounted()) {
      // The drive went away under the job: not its fault, so no attempt is spent.
      release(db, job.id, { delayMs: MEDIA_RETRY_MS });
      log.warn(`${job.kind} job ${job.id} waits for the photo drive: ${err.message}`);
      return;
    }
    const outcome = fail(db, job, err);
    log.warn(`${job.kind} job ${job.id} (attempt ${job.attempts}) failed: ${err.message}${outcome === 'queued' ? '; will retry' : ''}`);
    if (outcome === 'failed') {
      try {
        await handler.onFailed?.(ctx, job, err);
      } catch (hookErr) {
        log.error(`Could not record the failure of ${job.kind} job ${job.id}: ${hookErr.message}`);
      }
    }
  }

  function launch(job) {
    const controller = new AbortController();
    running[job.kind] += 1;
    const promise = runJob(job, controller).finally(() => {
      running[job.kind] -= 1;
      inflight.delete(job.id);
      if (!stopping) setImmediate(tick);
    });
    inflight.set(job.id, { controller, promise });
  }

  // Claims and starts as many jobs as there are free slots. Returns how many started.
  function tick() {
    if (stopping) return 0;
    if (!mediaMounted()) return 0;
    let started = 0;
    for (const kind of kinds) {
      while (running[kind] < concurrency[kind]) {
        let job;
        try {
          job = claim(db, { workerId, kinds: [kind] });
        } catch (err) {
          log.error(`Could not claim a ${kind} job: ${err.message}`);
          return started;
        }
        if (!job) break;
        launch(job);
        started += 1;
      }
    }
    return started;
  }

  // The nightly snapshot: one at a time, never while stopping.
  let snapshotRun = null;
  function checkSnapshot() {
    if (stopping || snapshotRun) return snapshotRun;
    snapshotRun = snapshotIfDue({ db, config, log })
      .catch((err) => {
        log.error(`The database snapshot failed: ${err.message}`);
        return null;
      })
      .finally(() => {
        snapshotRun = null;
      });
    return snapshotRun;
  }
  const snapshotTimers = [];
  if (snapshots) {
    snapshotTimers.push(setTimeout(checkSnapshot, snapshots.firstCheckMs ?? 30_000));
    snapshotTimers.push(setInterval(checkSnapshot, snapshots.checkMs ?? 60_000));
    for (const timer of snapshotTimers) timer.unref?.();
  }

  beat();
  const heartbeat = setInterval(beat, heartbeatMs);
  const poller = setInterval(tick, pollMs);
  const sweeper = setInterval(sweep, sweepMs);
  heartbeat.unref?.();
  sweeper.unref?.();
  reclaiming.finally(() => setImmediate(tick));

  return {
    workerId,
    tick,
    checkSnapshot,
    // Resolves when nothing is running (tests use it after tick()).
    async drain() {
      while (inflight.size) await Promise.allSettled([...inflight.values()].map((j) => j.promise));
    },
    get running() {
      return { ...running };
    },
    async stop() {
      if (stopping) return;
      stopping = true;
      clearInterval(poller);
      clearInterval(heartbeat);
      clearInterval(sweeper);
      await reclaiming;
      for (const timer of snapshotTimers) clearTimeout(timer);
      const all = () => Promise.allSettled([...inflight.values()].map((j) => j.promise));
      let timer;
      const grace = new Promise((resolve) => {
        timer = setTimeout(resolve, graceMs);
      });
      await Promise.race([all(), grace]);
      clearTimeout(timer);
      for (const { controller } of inflight.values()) controller.abort();
      await all();
      await snapshotRun; // a snapshot is quick; let it finish so no temp file is left
    },
  };
}

export default startRunner;
