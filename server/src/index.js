// Starts the web app: node src/index.js

import { buildApp } from './app.js';
import { loadConfig } from './config.js';

let config;
try {
  config = loadConfig(process.env);
} catch (err) {
  console.error(`gma: ${err.message}`);
  process.exit(78); // EX_CONFIG
}

const app = await buildApp(config);

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
