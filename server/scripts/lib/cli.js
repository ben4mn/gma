// Small helpers the CLIs share. Each script exports main(argv, { env, out })
// returning an exit code, so tests can run it in-process with temp dirs; it
// only runs itself when started directly (node scripts/<name>.js).

import fs from 'node:fs';
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import { loadConfig } from '../../src/config.js';
import { openDb } from '../../src/db/index.js';

export const EXIT = Object.freeze({ OK: 0, FAIL: 1, USAGE: 64, CONFIG: 78 });

export class UsageError extends Error {}

// parseArgs, but unknown flags and missing values become a UsageError.
export function parseFlags(argv, options) {
  try {
    return parseArgs({ args: argv, options, strict: true, allowPositionals: false }).values;
  } catch (err) {
    throw new UsageError(err.message);
  }
}

// Loads the config and opens the database the app uses. The caller closes db.
export function openFromEnv(env) {
  const config = loadConfig(env);
  return { config, db: openDb(config.dbPath) };
}

function isMain(metaUrl) {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return metaUrl === pathToFileURL(fs.realpathSync(entry)).href;
  } catch {
    return false;
  }
}

// Runs main() when the script was started directly, mapping errors to exit codes.
export async function runIfMain(metaUrl, main, usage) {
  if (!isMain(metaUrl)) return;
  try {
    process.exitCode = await main(process.argv.slice(2));
  } catch (err) {
    if (err instanceof UsageError) {
      console.error(`${err.message}\n\n${usage}`);
      process.exitCode = EXIT.USAGE;
    } else if (err.name === 'ConfigError') {
      console.error(`gma: ${err.message}`);
      process.exitCode = EXIT.CONFIG;
    } else {
      console.error(`gma: ${err.stack ?? err.message}`);
      process.exitCode = EXIT.FAIL;
    }
  }
}
