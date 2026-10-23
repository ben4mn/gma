#!/usr/bin/env node
// Prints a new VAPID key pair for web push as .env lines (notes go to stderr,
// so `node scripts/gen-vapid.js >> ../.env` appends only the keys).
// Generate once and never rotate: new keys cut off every phone that turned
// notifications on, so this refuses when keys are already set unless --force.
//
//   npm run -s vapid:gen -- --subject mailto:ben@example.com

import webpush from 'web-push';
import { EXIT, UsageError, parseFlags, runIfMain } from './lib/cli.js';

export const USAGE = 'Usage: npm run -s vapid:gen -- [--subject mailto:you@example.com] [--force]';

export async function main(argv, { env = process.env, out = console } = {}) {
  const flags = parseFlags(argv, {
    subject: { type: 'string' },
    force: { type: 'boolean' },
    help: { type: 'boolean', short: 'h' },
  });
  if (flags.help) {
    out.log(USAGE);
    return EXIT.OK;
  }
  if ((env.VAPID_PUBLIC_KEY || env.VAPID_PRIVATE_KEY) && !flags.force) {
    out.error(
      'VAPID keys are already set. New keys would stop notifications on every phone that turned them on.\n' +
        'If you really mean to start over, run this again with --force.',
    );
    return EXIT.FAIL;
  }
  const subject = flags.subject ?? (env.VAPID_SUBJECT || null);
  if (subject && !/^(mailto:[^\s@]+@[^\s@]+|https:\/\/\S+)$/.test(subject)) {
    throw new UsageError('--subject must be a mailto: address (mailto:you@example.com) or an https:// URL.');
  }

  const { publicKey, privateKey } = webpush.generateVAPIDKeys();
  out.log(`VAPID_PUBLIC_KEY=${publicKey}`);
  out.log(`VAPID_PRIVATE_KEY=${privateKey}`);
  if (subject) out.log(`VAPID_SUBJECT=${subject}`);
  out.error('# Put these lines in .env and keep them forever (changing them breaks every push subscription).');
  if (!subject) out.error('# Also set VAPID_SUBJECT=mailto:<an address you read>. Apple refuses placeholder addresses.');
  return EXIT.OK;
}

await runIfMain(import.meta.url, main, USAGE);
