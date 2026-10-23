// The worker's job loop: startRunner({ config, db, storage, log }) → { stop() }.
//
// Every second it claims due jobs while each kind has a free slot (video 1,
// image 2, voice 1), runs them, and marks them done or failed (with backoff,
// see queue.js). At boot it requeues jobs a dead worker left running. It
// writes worker_last_seen every 15 s. stop() stops claiming, lets running jobs
// finish for a grace period, then cancels the rest and puts them back in the
// queue without spending an attempt.

import os from 'node:os';
import { randomBytes } from 'node:crypto';
import { createMediaTools } from '../lib/media.js';
import { setSetting } from '../lib/settings.js';
import { claim, complete, fail, release, requeueStale, JOB_KINDS } from './queue.js';
import * as imageJob from './image.js';
import * as videoJob from './video.js';
import * as voiceJob from './voice.js';

export const DEFAULT_CONCURRENCY = Object.freeze({ video: 1, image: 2, voice: 1 });
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
  workerId = `${os.hostname()}:${process.pid}:${randomBytes(3).toString('hex')}`,
} = {}) {
  const kinds = JOB_KINDS.filter((kind) => handlers[kind] && (concurrency[kind] ?? 0) > 0);
  const running = Object.fromEntries(kinds.map((kind) => [kind, 0]));
  const inflight = new Map(); // job id → { controller, promise }
  let stopping = false;

  const reclaimed = requeueStale(db);
  if (reclaimed) log.warn(`Requeued ${reclaimed} job(s) a stopped worker left running`);

  function beat() {
    try {
      setSetting(db, 'worker_last_seen', Date.now());
    } catch (err) {
      log.warn(`Could not write worker_last_seen: ${err.message}`);
    }
  }

  async function runJob(job, controller) {
    const handler = handlers[job.kind];
    const ctx = { config, db, storage, log, media, push, signal: controller.signal };
    try {
      await handler.run(ctx, job);
      complete(db, job.id);
    } catch (err) {
      if (stopping && controller.signal.aborted) {
        release(db, job.id);
        log.info(`Put ${job.kind} job ${job.id} back in the queue for the next start`);
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

  beat();
  const heartbeat = setInterval(beat, heartbeatMs);
  const poller = setInterval(tick, pollMs);
  heartbeat.unref?.();
  setImmediate(tick);

  return {
    workerId,
    tick,
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
      const all = () => Promise.allSettled([...inflight.values()].map((j) => j.promise));
      let timer;
      const grace = new Promise((resolve) => {
        timer = setTimeout(resolve, graceMs);
      });
      await Promise.race([all(), grace]);
      clearTimeout(timer);
      for (const { controller } of inflight.values()) controller.abort();
      await all();
    },
  };
}

export default startRunner;
