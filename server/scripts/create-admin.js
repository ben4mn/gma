#!/usr/bin/env node
// Makes someone an admin (Ben, the first time). Safe to run again: an existing
// person with that email is promoted (or restored) instead of duplicated.
//
//   npm run admin:create -- --name "Ben Lee" --email ben@example.com
//   docker compose -f deploy/docker-compose.yml run --rm app npm run admin:create -- --name … --email …

import { cleanEmail, cleanName, ensureAdmin, logAdmin } from '../src/routes/admin.js';
import { EXIT, UsageError, openFromEnv, parseFlags, runIfMain } from './lib/cli.js';

export const USAGE = 'Usage: npm run admin:create -- --name "Ben Lee" --email ben@example.com';

const OUTCOME = {
  created: (u) => `Added ${u.name} <${u.email}> as an admin.`,
  promoted: (u) => `${u.name} <${u.email}> is now an admin.`,
  restored: (u) => `Restored ${u.name} <${u.email}> and made them an admin.`,
  unchanged: (u) => `${u.name} <${u.email}> is already an admin. Nothing changed.`,
};

export async function main(argv, { env = process.env, out = console } = {}) {
  const flags = parseFlags(argv, {
    name: { type: 'string' },
    email: { type: 'string' },
    help: { type: 'boolean', short: 'h' },
  });
  if (flags.help) {
    out.log(USAGE);
    return EXIT.OK;
  }
  let name;
  let email;
  try {
    name = cleanName(flags.name, { what: 'a name with --name' });
    email = cleanEmail(flags.email);
  } catch (err) {
    throw new UsageError(err.message);
  }
  if (!email) throw new UsageError('Add an email with --email.');

  const { config, db } = openFromEnv(env);
  try {
    const { user, outcome } = ensureAdmin(db, { name, email });
    if (outcome !== 'unchanged') logAdmin(db, { action: 'cli.admin_create', target: user.id, detail: { outcome } });
    out.log(OUTCOME[outcome](user));
    out.log(`Sign in at ${config.publicUrl}/signin with that email. We'll email you a code.`);
    return EXIT.OK;
  } finally {
    db.close();
  }
}

await runIfMain(import.meta.url, main, USAGE);
