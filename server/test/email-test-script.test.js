// scripts/email-test.js: `npm run -s email:test -- --to <address>` sends one
// short email through the configured transport and prints only "sent" or the
// error's class and message.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, test } from 'node:test';
import { main, USAGE } from '../scripts/email-test.js';
import { UsageError } from '../scripts/lib/cli.js';

const PASS = 'abcdwxyzefghmnop';
const ENV = { NODE_ENV: 'test', LOG_LEVEL: 'silent', EMAIL_TRANSPORT: 'smtp', SMTP_USER: 'grandmas.family@gmail.com', SMTP_PASS: PASS };
const SCRIPT = fileURLToPath(new URL('../scripts/email-test.js', import.meta.url));

function capture() {
  const lines = { out: [], err: [] };
  return {
    out: { log: (s = '') => lines.out.push(String(s)), error: (s = '') => lines.err.push(String(s)) },
    text: () => lines.out.join('\n'),
    errors: () => lines.err.join('\n'),
    all: () => [...lines.out, ...lines.err].join('\n'),
  };
}

function fakeSmtp(fail) {
  const sent = [];
  const made = [];
  return {
    sent,
    made,
    createTransport: (options) => {
      made.push(options);
      return {
        async sendMail(message) {
          sent.push(message);
          if (fail) throw fail;
          return { messageId: '<t@gmail.com>' };
        },
        close() {},
      };
    },
  };
}

describe('email:test', () => {
  test('package.json runs it as email:test', async () => {
    const pkg = JSON.parse(await import('node:fs/promises').then((fs) => fs.readFile(new URL('../package.json', import.meta.url), 'utf8')));
    assert.equal(pkg.scripts['email:test'], 'node scripts/email-test.js');
    assert.match(pkg.dependencies.nodemailer, /^\^?\d+\.\d+\.\d+$/);
  });

  test('--to sends one short email and prints only "sent"', async () => {
    const smtp = fakeSmtp();
    const io = capture();
    const code = await main(['--to', 'ben@example.com'], { env: ENV, out: io.out, createTransport: smtp.createTransport });
    assert.equal(code, 0);
    assert.equal(io.text(), 'sent');
    assert.equal(io.errors(), '');
    assert.equal(smtp.sent.length, 1);
    assert.equal(smtp.sent[0].to, 'ben@example.com');
    assert.equal(smtp.sent[0].from, '"Grandma\'s family" <grandmas.family@gmail.com>');
    assert.match(smtp.sent[0].subject, /test/i);
    assert.ok(smtp.sent[0].text.length < 600);
    assert.equal(smtp.made[0].auth.pass, PASS);
  });

  test('--to=<address> works too', async () => {
    const smtp = fakeSmtp();
    const io = capture();
    assert.equal(await main(['--to=ben@example.com'], { env: ENV, out: io.out, createTransport: smtp.createTransport }), 0);
    assert.equal(smtp.sent[0].to, 'ben@example.com');
  });

  test('a failure prints the error class and message, never the password, and exits 1', async () => {
    const smtp = fakeSmtp(Object.assign(new Error(`Invalid login: 535 ${PASS}`), { code: 'EAUTH', responseCode: 535 }));
    const io = capture();
    const code = await main(['--to', 'ben@example.com'], { env: ENV, out: io.out, createTransport: smtp.createTransport });
    assert.equal(code, 1);
    assert.equal(io.text(), '');
    assert.match(io.errors(), /^EmailError: The email server refused the sign-in: .*app password \(EAUTH 535\)$/);
    assert.ok(!io.all().includes(PASS));
  });

  test('a broken config prints ConfigError and its message, and exits 78', async () => {
    const io = capture();
    const code = await main(['--to', 'ben@example.com'], { env: { ...ENV, SMTP_USER: '' }, out: io.out });
    assert.equal(code, 78);
    assert.match(io.errors(), /^ConfigError: SMTP_USER is required when EMAIL_TRANSPORT=smtp/);
    assert.ok(!io.all().includes(PASS));
  });

  test('the console transport says it only printed the message', async () => {
    const io = capture();
    const logged = [];
    const realLog = console.log;
    console.log = (...args) => logged.push(args.join(' '));
    let code;
    try {
      code = await main(['--to', 'ben@example.com'], { env: { NODE_ENV: 'test', LOG_LEVEL: 'silent' }, out: io.out });
    } finally {
      console.log = realLog;
    }
    assert.equal(code, 0);
    assert.match(io.text(), /^printed, not sent/);
    assert.match(logged.join('\n'), /email to ben@example.com/);
  });

  test('a missing, empty or malformed --to, or a stray argument, is a usage error', async () => {
    const io = capture();
    await assert.rejects(main([], { env: ENV, out: io.out }), (err) => err instanceof UsageError && /--to/.test(err.message));
    await assert.rejects(main(['--to'], { env: ENV, out: io.out }), UsageError);
    await assert.rejects(main(['--to', ''], { env: ENV, out: io.out }), UsageError);
    await assert.rejects(main(['--to', 'not-an-address'], { env: ENV, out: io.out }), UsageError);
    await assert.rejects(main(['--to', 'a@b.co', '--bcc', 'x@y.z'], { env: ENV, out: io.out }), UsageError);
    await assert.rejects(main(['ben@example.com'], { env: ENV, out: io.out }), UsageError);
    assert.equal(io.all(), '');
  });

  test('--help prints the usage', async () => {
    const io = capture();
    assert.equal(await main(['--help'], { env: ENV, out: io.out }), 0);
    assert.equal(io.text(), USAGE);
    assert.match(USAGE, /email:test -- --to/);
  });

  test('run as a script: a usage error exits 64, and nothing prints the password', () => {
    const run = spawnSync(process.execPath, [SCRIPT], { env: { ...ENV, PATH: process.env.PATH }, encoding: 'utf8' });
    assert.equal(run.status, 64);
    assert.match(run.stderr, /--to/);
    assert.ok(!(run.stdout + run.stderr).includes(PASS));
  });
});
