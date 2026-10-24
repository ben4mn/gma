#!/usr/bin/env node
// Pairs Grandma's frame and prints its link once. The link signs the frame in,
// so keep it private; only its hash is stored. Lost it? Unpair the frame in
// /admin and pair again.
//
//   npm run device:pair -- --name "Grandma's frame"

import { cleanName, logAdmin, pairDevice } from '../src/lib/admin.js';
import { EXIT, UsageError, openFromEnv, parseFlags, runIfMain } from './lib/cli.js';

export const USAGE = 'Usage: npm run device:pair -- --name "Grandma\'s frame"';

export async function main(argv, { env = process.env, out = console } = {}) {
  const flags = parseFlags(argv, { name: { type: 'string' }, help: { type: 'boolean', short: 'h' } });
  if (flags.help) {
    out.log(USAGE);
    return EXIT.OK;
  }
  let name = "Grandma's frame";
  if (flags.name !== undefined) {
    try {
      name = cleanName(flags.name, { what: 'a name with --name', max: 60 });
    } catch (err) {
      throw new UsageError(err.message);
    }
  }

  const { config, db } = openFromEnv(env);
  try {
    const { device, url } = pairDevice(db, { name, createdBy: null, publicUrl: config.publicUrl });
    logAdmin(db, { action: 'cli.device_pair', target: device.id, detail: { name } });
    out.log(`Paired “${name}”. Its link is shown only this once:`);
    out.log('');
    out.log(`  ${url}`);
    out.log('');
    out.log('Put it in the kiosk setup (see pi/README.md). Anyone with this link can see the family photos.');
    return EXIT.OK;
  } finally {
    db.close();
  }
}

await runIfMain(import.meta.url, main, USAGE);
