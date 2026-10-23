#!/usr/bin/env node
// Sends one short test email through the configured transport, to check the
// email settings (deploy/use-gmail.sh offers to run it):
//
//   npm run -s email:test -- --to you@example.com
//   docker compose exec -T app npm run -s email:test -- --to you@example.com   (on the server)
//
// Prints only "sent", or the error's class and message (exit 1; a bad setting
// is exit 78). Never the settings, never the password.

import { loadConfig } from '../src/config.js';
import { cleanEmail } from '../src/lib/admin.js';
import { sendEmail, testEmail, useSmtpFactory } from '../src/lib/email.js';
import { EXIT, UsageError, parseFlags, runIfMain } from './lib/cli.js';

export const USAGE = 'Usage: npm run -s email:test -- --to you@example.com';

// Belt and braces: no secret from the config ever reaches the terminal, even
// inside an error message we didn't write.
function scrub(text, config) {
  let out = String(text ?? '');
  for (const secret of [config?.smtpPass, config?.resendApiKey]) {
    if (secret && secret.length >= 4) out = out.split(secret).join('[hidden]');
  }
  return out.replace(/\s+/g, ' ').trim();
}

// Options (tests): `createTransport`, a fake nodemailer for the smtp transport.
export async function main(argv, { env = process.env, out = console, createTransport } = {}) {
  const flags = parseFlags(argv, {
    to: { type: 'string' },
    help: { type: 'boolean', short: 'h' },
  });
  if (flags.help) {
    out.log(USAGE);
    return EXIT.OK;
  }
  let to;
  try {
    to = cleanEmail(flags.to);
  } catch (err) {
    throw new UsageError(err.message);
  }
  if (!to) throw new UsageError('Add the address to send the test to with --to.');

  let config;
  try {
    config = loadConfig(env);
  } catch (err) {
    out.error(`${err.name}: ${err.message}`);
    return EXIT.CONFIG;
  }
  if (createTransport) useSmtpFactory(config, createTransport);

  try {
    const result = await sendEmail(config, {
      to,
      ...testEmail({ publicUrl: config.publicUrl, transport: config.emailTransport }),
    });
    out.log(result?.printed ? 'printed, not sent: EMAIL_TRANSPORT=console prints mail to the log' : 'sent');
    return EXIT.OK;
  } catch (err) {
    out.error(`${err?.name || 'Error'}: ${scrub(err?.message, config)}`);
    return EXIT.FAIL;
  }
}

await runIfMain(import.meta.url, main, USAGE);
