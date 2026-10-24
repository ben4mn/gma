// Starts the web app: node src/index.js

import path from 'node:path';
import { buildApp } from './app.js';
import { loadConfig } from './config.js';
import { snapshotBeforeMigrations } from './db/index.js';
import { assertMediaMounted, MediaNotMountedError } from './lib/storage.js';

let config;
try {
  config = loadConfig(process.env);
  // Refuse to start on an unmounted photo drive rather than write to the SSD.
  assertMediaMounted(config.mediaDir, config.mediaSentinel);
} catch (err) {
  console.error(`gma: ${err.message}`);
  process.exit(78); // EX_CONFIG
}

// An upgrade with new migrations copies the database onto the drive first (OPS-11).
try {
  const copy = await snapshotBeforeMigrations({ dbPath: config.dbPath, backupsDir: path.join(config.mediaDir, 'backups') });
  if (copy) console.log(`gma: saved a copy of the database before upgrading it: ${copy}`);
} catch (err) {
  console.error(`gma: could not copy the database before upgrading it, so it was left as it is: ${err.message}`);
  process.exit(1);
}

let app;
try {
  app = await buildApp(config);
} catch (err) {
  if (!(err instanceof MediaNotMountedError)) throw err;
  console.error(`gma: ${err.message}`); // the drive went away during start
  process.exit(78);
}

let closing = false;
async function shutdown(signal) {
  if (closing) return;
  closing = true;
  app.log.info({ signal }, 'Shutting down');
  const force = setTimeout(() => process.exit(1), 10_000);
  force.unref();
  try {
    await app.close();
    process.exit(0);
  } catch (err) {
    app.log.error({ err }, 'Shutdown failed');
    process.exit(1);
  }
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

try {
  await app.listen({ host: config.host, port: config.port });
} catch (err) {
  app.log.error({ err }, 'Could not start the server');
  console.error(`gma: could not listen on ${config.host}:${config.port}: ${err.message}`);
  process.exit(1);
}
