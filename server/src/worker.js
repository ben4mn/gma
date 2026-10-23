// Starts the media worker: node src/worker.js
//
// The job loop lives in ./jobs/runner.js (the media pipeline), which exports
//   startRunner({ config, db, storage, log }) → { stop(): Promise<void> | void }
// This file checks the photo drive is mounted (MEDIA_SENTINEL), opens the
// database, starts the runner, writes worker_last_seen to settings every 15 s
// (GET /healthz reports it) and stops cleanly on SIGTERM.

import fs from 'node:fs';
import { loadConfig } from './config.js';
import { openDb } from './db/index.js';
import { setSetting } from './lib/settings.js';
import { assertMediaMounted, createStorage } from './lib/storage.js';

const HEARTBEAT_MS = 15_000;

const log = {
  info: (...args) => console.log('[worker]', ...args),
  warn: (...args) => console.warn('[worker]', ...args),
  error: (...args) => console.error('[worker]', ...args),
};

let config;
try {
  config = loadConfig(process.env);
  // Refuse to start on an unmounted photo drive rather than write to the SSD.
  assertMediaMounted(config.mediaDir, config.mediaSentinel);
} catch (err) {
  console.error(`gma worker: ${err.message}`);
  process.exit(78); // EX_CONFIG
}

const RUNNER_URL = new URL('./jobs/runner.js', import.meta.url);
if (!fs.existsSync(RUNNER_URL)) {
  log.error('src/jobs/runner.js is missing, so there is no job loop to run yet.');
  process.exit(1);
}
let runnerModule;
try {
  runnerModule = await import(RUNNER_URL.href);
} catch (err) {
  log.error('Could not load the job runner:', err);
  process.exit(1);
}

const startRunner = runnerModule.startRunner ?? runnerModule.default;
if (typeof startRunner !== 'function') {
  log.error('src/jobs/runner.js must export startRunner({ config, db, storage, log }).');
  process.exit(1);
}

const storage = createStorage(config.mediaDir, { sentinel: config.mediaSentinel });
try {
  await storage.init();
} catch (err) {
  log.error(err.message);
  process.exit(err.code === 'media_not_mounted' ? 78 : 1);
}
const db = openDb(config.dbPath);

const beat = () => {
  try {
    setSetting(db, 'worker_last_seen', Date.now());
  } catch (err) {
    log.warn('Could not write worker_last_seen:', err.message);
  }
};
beat();
const heartbeat = setInterval(beat, HEARTBEAT_MS);

const runner = await startRunner({ config, db, storage, log });
log.info('Started');

let stopping = false;
async function shutdown(signal) {
  if (stopping) return;
  stopping = true;
  log.info(`${signal}: stopping`);
  clearInterval(heartbeat);
  const force = setTimeout(() => process.exit(1), 30_000);
  force.unref();
  try {
    await runner?.stop?.();
    db.close();
    process.exit(0);
  } catch (err) {
    log.error('Shutdown failed:', err);
    process.exit(1);
  }
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
