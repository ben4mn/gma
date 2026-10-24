// EMAIL_TRANSPORT=smtp: the config keys, the nodemailer wiring, errors that
// never carry the password or the address, and what the app does with them.
// No test ever opens a socket: every transport here is a fake handed in with
// useSmtpFactory(config, factory).

import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { inspect } from 'node:util';
import { describe, test } from 'node:test';
import { err as serializeErr } from 'pino-std-serializers';
import { buildApp } from '../src/app.js';
import { ConfigError, loadConfig } from '../src/config.js';
import { captureEmails, EmailError, sendEmail, SMTP_TIMEOUTS, smtpOptions, useSmtpFactory } from '../src/lib/email.js';
import { loginAs, makeTempDir, makeTestConfig, makeUser, sameOrigin } from './helpers/index.js';

const STRONG_SECRET = Buffer.alloc(48, 7).toString('base64');
const PASS = 'abcdwxyzefghmnop';
const GMAIL = { EMAIL_TRANSPORT: 'smtp', SMTP_USER: 'grandmas.family@gmail.com', SMTP_PASS: PASS };
const PROD = { NODE_ENV: 'production', PUBLIC_URL: 'https://gma.4mn.org', SECRET_KEY: STRONG_SECRET };

// A fake nodemailer: records the options and every message, answers like Gmail.
function fakeSmtp({ fail = null } = {}) {
  const made = [];
  const sent = [];
  const factory = (options) => {
    made.push(options);
    return {
      async sendMail(message) {
        sent.push(message);
        if (fail) throw fail;
        return { messageId: `<m${sent.length}@gmail.com>`, accepted: [message.to], rejected: [] };
      },
      close() {},
    };
  };
  return { factory, made, sent };
}

function smtpFailure(message, props = {}) {
  return Object.assign(new Error(message), props);
}

describe('config: EMAIL_TRANSPORT=smtp', () => {
  test('Gmail defaults: smtp.gmail.com, 465, implicit TLS, From is the account', () => {
    const config = loadConfig({ NODE_ENV: 'test', ...GMAIL });
    assert.equal(config.emailTransport, 'smtp');
    assert.equal(config.smtpHost, 'smtp.gmail.com');
    assert.equal(config.smtpPort, 465);
    assert.equal(config.smtpSecure, true);
    assert.equal(config.smtpUser, 'grandmas.family@gmail.com');
    assert.equal(config.smtpPass, PASS);
    assert.equal(config.emailFrom, '"Grandma\'s family" <grandmas.family@gmail.com>');
  });

  test('production loads with the six keys use-gmail.sh writes', () => {
    const config = loadConfig({
      ...PROD,
      SMTP_HOST: 'smtp.gmail.com',
      SMTP_PORT: '465',
      SMTP_USER: 'grandmas.family@gmail.com',
      SMTP_PASS: PASS,
      EMAIL_TRANSPORT: 'smtp',
      EMAIL_FROM: "Grandma's family <grandmas.family@gmail.com>",
    }, { warn: () => assert.fail('the From address is the account: no warning') });
    assert.equal(config.isProduction, true);
    assert.equal(config.smtpSecure, true);
    assert.equal(config.emailFrom, "Grandma's family <grandmas.family@gmail.com>");
  });

  test('port 587 means STARTTLS unless SMTP_SECURE says otherwise', () => {
    assert.equal(loadConfig({ NODE_ENV: 'test', ...GMAIL, SMTP_PORT: '587' }).smtpSecure, false);
    assert.equal(loadConfig({ NODE_ENV: 'test', ...GMAIL, SMTP_PORT: '587', SMTP_SECURE: 'true' }).smtpSecure, true);
    assert.equal(loadConfig({ NODE_ENV: 'test', ...GMAIL, SMTP_SECURE: 'false' }).smtpSecure, false);
    assert.equal(loadConfig({ NODE_ENV: 'test', ...GMAIL, SMTP_SECURE: 'yes' }).smtpSecure, true);
    assert.equal(loadConfig({ NODE_ENV: 'test', ...GMAIL, SMTP_SECURE: '0' }).smtpSecure, false);
  });

  test('smtp needs SMTP_USER and SMTP_PASS, in production and everywhere else', () => {
    for (const nodeEnv of [PROD, { NODE_ENV: 'test' }]) {
      assert.throws(() => loadConfig({ ...nodeEnv, EMAIL_TRANSPORT: 'smtp', SMTP_PASS: PASS }), (err) => {
        assert.ok(err instanceof ConfigError);
        assert.match(err.message, /SMTP_USER/);
        assert.match(err.message, /EMAIL_TRANSPORT=smtp/);
        assert.ok(!err.message.includes(PASS));
        return true;
      });
      assert.throws(
        () => loadConfig({ ...nodeEnv, EMAIL_TRANSPORT: 'smtp', SMTP_USER: 'a@gmail.com' }),
        /SMTP_PASS is required when EMAIL_TRANSPORT=smtp/,
      );
    }
  });

  test('malformed values fail with a readable message and never echo the password', () => {
    const base = { NODE_ENV: 'test', ...GMAIL };
    assert.throws(() => loadConfig({ ...base, SMTP_PORT: 'smtp' }), /SMTP_PORT must be a whole number/);
    assert.throws(() => loadConfig({ ...base, SMTP_PORT: '0' }), /SMTP_PORT must be a port number/);
    assert.throws(() => loadConfig({ ...base, SMTP_PORT: '70000' }), /SMTP_PORT must be a port number/);
    assert.throws(() => loadConfig({ ...base, SMTP_SECURE: 'sometimes' }), /SMTP_SECURE must be true or false/);
    assert.throws(() => loadConfig({ ...base, EMAIL_TRANSPORT: 'pigeon' }), /console, resend or smtp/);
    assert.throws(() => loadConfig({ ...base, SMTP_USER: 'apikey' }), /EMAIL_FROM/);
    assert.throws(() => loadConfig({ ...base, EMAIL_FROM: 'Grandma' }), /EMAIL_FROM/);
    // A user name that isn't an address is fine once EMAIL_FROM says who it's from.
    assert.equal(loadConfig({ ...base, SMTP_USER: 'apikey', EMAIL_FROM: 'Gma <a@b.org>' }).emailFrom, 'Gma <a@b.org>');
  });

  test("a Gmail app password copied with its spaces works (Google shows it as 'abcd efgh ijkl mnop')", () => {
    const config = loadConfig({ NODE_ENV: 'test', ...GMAIL, SMTP_PASS: 'abcd wxyz efgh mnop' });
    assert.equal(config.smtpPass, PASS);
    // Anything else is taken as it is.
    assert.equal(loadConfig({ NODE_ENV: 'test', ...GMAIL, SMTP_PASS: 'pa ss' }).smtpPass, 'pa ss');
  });

  test('the password is never printed with the config', () => {
    const config = loadConfig({ NODE_ENV: 'test', ...GMAIL });
    assert.equal(config.smtpPass, PASS);
    assert.ok(Object.isFrozen(config));
    assert.ok(!JSON.stringify(config).includes(PASS));
    assert.ok(!inspect(config, { depth: 5 }).includes(PASS));
    assert.ok(!Object.keys(config).includes('smtpPass'));
  });

  test('warns once when EMAIL_FROM is another address (Gmail rewrites it), never with the password', () => {
    const lines = [];
    loadConfig({ NODE_ENV: 'test', ...GMAIL, EMAIL_FROM: "Grandma's family <hello@auth.4mn.org>" }, { warn: (l) => lines.push(l) });
    assert.equal(lines.length, 1);
    assert.match(lines[0], /EMAIL_FROM/);
    assert.match(lines[0], /SMTP_USER/);
    assert.match(lines[0], /alias/);
    assert.ok(!lines[0].includes(PASS));
    assert.ok(!lines[0].includes('\n'));

    const none = [];
    loadConfig({ NODE_ENV: 'test', ...GMAIL, EMAIL_FROM: 'Gma <Grandmas.Family@gmail.com>' }, { warn: (l) => none.push(l) });
    loadConfig({ NODE_ENV: 'test', ...GMAIL }, { warn: (l) => none.push(l) });
    loadConfig({ NODE_ENV: 'test' }, { warn: (l) => none.push(l) });
    assert.deepEqual(none, []);
  });

  test('console and resend keep their From default', () => {
    assert.equal(loadConfig({ NODE_ENV: 'test' }).emailFrom, "Grandma's family <hello@auth.4mn.org>");
    assert.equal(
      loadConfig({ NODE_ENV: 'test', EMAIL_TRANSPORT: 'resend', RESEND_API_KEY: 're_x' }).emailFrom,
      "Grandma's family <hello@auth.4mn.org>",
    );
  });
});

describe('the smtp transport', () => {
  test('wires host, port, TLS, auth and timeouts into nodemailer, one connection per message', () => {
    const config = loadConfig({ NODE_ENV: 'test', ...GMAIL });
    const options = smtpOptions(config);
    assert.equal(options.host, 'smtp.gmail.com');
    assert.equal(options.port, 465);
    assert.equal(options.secure, true);
    assert.deepEqual(options.auth, { user: 'grandmas.family@gmail.com', pass: PASS });
    assert.equal(options.connectionTimeout, 10_000);
    assert.equal(options.greetingTimeout, 10_000);
    assert.equal(options.socketTimeout, 20_000);
    assert.deepEqual(SMTP_TIMEOUTS, { connectionTimeout: 10_000, greetingTimeout: 10_000, socketTimeout: 20_000 });
    assert.equal(options.pool, undefined);
    assert.equal(options.logger, false);
    assert.equal(options.debug, false);
    assert.equal(options.disableFileAccess, true);
    assert.equal(options.disableUrlAccess, true);

    // Port 587: STARTTLS is required, so the password never crosses in the clear.
    const starttls = smtpOptions(loadConfig({ NODE_ENV: 'test', ...GMAIL, SMTP_PORT: '587' }));
    assert.equal(starttls.secure, false);
    assert.equal(starttls.requireTLS, true);
  });

  test('sends from the account and counts as emailed (no `printed`)', async () => {
    const config = loadConfig({ NODE_ENV: 'test', ...GMAIL });
    const smtp = fakeSmtp();
    useSmtpFactory(config, smtp.factory);
    const result = await sendEmail(config, { to: 'sarah@example.com', subject: 'Hi', text: 'Hello', html: '<p>Hello</p>' });
    assert.equal(result.id, '<m1@gmail.com>');
    assert.equal(result.printed, undefined);
    assert.equal(smtp.made.length, 1);
    assert.equal(smtp.made[0].auth.pass, PASS);
    assert.deepEqual(smtp.sent, [
      { from: '"Grandma\'s family" <grandmas.family@gmail.com>', to: 'sarah@example.com', subject: 'Hi', text: 'Hello', html: '<p>Hello</p>' },
    ]);
  });

  test('the test capture hook still wins over smtp', async () => {
    const config = loadConfig({ NODE_ENV: 'test', ...GMAIL });
    const smtp = fakeSmtp();
    useSmtpFactory(config, smtp.factory);
    const box = captureEmails(config);
    await sendEmail(config, { to: 'a@example.com', subject: 'Hi', text: 'x' });
    assert.equal(box.length, 1);
    assert.equal(smtp.sent.length, 0);
  });

  test('a failure is an EmailError with the reason, the SMTP code and the domain, never the password or the address', async () => {
    const config = loadConfig({ NODE_ENV: 'test', ...GMAIL });
    const leaky = smtpFailure(
      `Invalid login: 535-5.7.8 Username and Password not accepted for grandmas.family@gmail.com / ${PASS} to sarah@example.com`,
      { code: 'EAUTH', responseCode: 535, response: `535 ${PASS}`, command: `AUTH PLAIN ${Buffer.from(PASS).toString('base64')}` },
    );
    useSmtpFactory(config, fakeSmtp({ fail: leaky }).factory);
    const err = await sendEmail(config, { to: 'sarah@example.com', subject: 'Your code 123456', text: 'code 123456' }).then(
      () => assert.fail('should have failed'),
      (e) => e,
    );
    assert.ok(err instanceof EmailError);
    assert.equal(err.code, 'EAUTH');
    assert.equal(err.status, 535);
    assert.equal(err.domain, 'example.com');
    assert.match(err.message, /refused the sign-in/);
    assert.match(err.message, /app password/);
    assert.match(err.message, /EAUTH 535/);
    // What the app's logger would print for { err }.
    const logged = JSON.stringify(serializeErr(err));
    for (const secret of [PASS, Buffer.from(PASS).toString('base64'), 'sarah@', 'grandmas.family', '123456']) {
      assert.ok(!logged.includes(secret), `the log line has ${secret}: ${logged}`);
    }
    assert.equal(err.cause, undefined);
  });

  test('network trouble, a refused address and an unknown error read differently', async () => {
    const config = loadConfig({ NODE_ENV: 'test', ...GMAIL });
    const cases = [
      [smtpFailure('Greeting never received', { code: 'ETIMEDOUT' }), /Could not reach the email server \(ETIMEDOUT\)/],
      [smtpFailure('connect ECONNREFUSED 1.2.3.4:465', { code: 'ESOCKET' }), /Could not reach the email server \(ESOCKET\)/],
      [smtpFailure('Recipient command failed: 550 sarah@example.com', { code: 'EENVELOPE', responseCode: 550 }), /refused the address \(EENVELOPE 550\)/],
      [smtpFailure(`weird ${PASS}`, { code: 'lower case is not a code' }), /^The email server refused the message$/],
      [new TypeError(`boom ${PASS}`), /^The email server refused the message$/],
    ];
    for (const [failure, expected] of cases) {
      useSmtpFactory(config, fakeSmtp({ fail: failure }).factory);
      await assert.rejects(sendEmail(config, { to: 'sarah@example.com', subject: 'Hi', text: 'x' }), (err) => {
        assert.ok(err instanceof EmailError);
        assert.match(err.message, expected);
        assert.ok(!err.message.includes(PASS));
        assert.ok(!err.message.includes('sarah@'));
        return true;
      });
    }
  });

  test('a transport that throws while being made is an EmailError too', async () => {
    const config = loadConfig({ NODE_ENV: 'test', ...GMAIL });
    useSmtpFactory(config, () => {
      throw new Error(`bad options ${PASS}`);
    });
    await assert.rejects(sendEmail(config, { to: 'a@example.com', subject: 'Hi', text: 'x' }), (err) => {
      assert.ok(err instanceof EmailError);
      assert.ok(!err.message.includes(PASS));
      return true;
    });
  });
});

describe('the app on the smtp transport', () => {
  async function smtpApp(smtp) {
    const tempDir = await makeTempDir();
    // No capture box: sendEmail really calls the (fake) SMTP transport.
    const config = makeTestConfig(tempDir, GMAIL);
    useSmtpFactory(config, smtp.factory);
    const app = await buildApp(config);
    return {
      app,
      async cleanup() {
        await app.close();
        await fs.rm(tempDir, { recursive: true, force: true });
      },
    };
  }

  test('an invite sent through smtp counts as emailed: the link signs them in', async () => {
    const smtp = fakeSmtp();
    const { app, cleanup } = await smtpApp(smtp);
    try {
      const admin = makeUser(app.db, { role: 'admin', name: 'Ben Lee' });
      const res = await app.inject({
        method: 'POST',
        url: '/api/admin/invites',
        headers: sameOrigin(loginAs(app, app.db, admin)),
        payload: { name: 'Sarah', email: 'sarah@example.com', send: true },
      });
      assert.equal(res.statusCode, 201, res.body);
      assert.equal(res.json().sent, true);
      assert.ok(res.json().invite.sent_at, 'sent_at is set: the app emailed it');
      assert.equal(smtp.sent.length, 1);
      assert.equal(smtp.sent[0].to, 'sarah@example.com');
      assert.match(smtp.sent[0].subject, /Ben Lee invited you/);
      const token = res.json().url.split('/join/')[1];
      const lookup = await app.inject({ method: 'GET', url: `/api/invites/${token}` });
      assert.equal(lookup.json().emailed, true);
    } finally {
      await cleanup();
    }
  });

  test('a failed invite send is the 424 email_failed, without the password', async () => {
    const smtp = fakeSmtp({ fail: smtpFailure(`Invalid login ${PASS}`, { code: 'EAUTH', responseCode: 535 }) });
    const { app, cleanup } = await smtpApp(smtp);
    try {
      const admin = makeUser(app.db, { role: 'admin' });
      const res = await app.inject({
        method: 'POST',
        url: '/api/admin/invites',
        headers: sameOrigin(loginAs(app, app.db, admin)),
        payload: { name: 'Sam', email: 'sam@example.com', send: true },
      });
      assert.equal(res.statusCode, 424);
      assert.equal(res.json().error.code, 'email_failed');
      assert.ok(!res.body.includes(PASS));
      assert.equal(app.db.prepare('SELECT COUNT(*) AS n FROM invites').get().n, 0);
    } finally {
      await cleanup();
    }
  });

  test('a failed sign-in code still answers 200, and the unsent code is dropped', async () => {
    const smtp = fakeSmtp({ fail: smtpFailure('Greeting never received', { code: 'ETIMEDOUT' }) });
    const { app, cleanup } = await smtpApp(smtp);
    try {
      makeUser(app.db, { email: 'sarah@example.com' });
      const res = await app.inject({
        method: 'POST',
        url: '/api/auth/code/request',
        headers: sameOrigin(),
        payload: { email: 'sarah@example.com' },
      });
      assert.equal(res.statusCode, 200);
      assert.deepEqual(res.json(), { ok: true });
      for (let i = 0; i < 50 && smtp.sent.length === 0; i += 1) await new Promise((r) => setTimeout(r, 10));
      assert.equal(smtp.sent.length, 1);
      await new Promise((r) => setTimeout(r, 20));
      assert.equal(app.db.prepare('SELECT COUNT(*) AS n FROM login_codes').get().n, 0);
    } finally {
      await cleanup();
    }
  });
});
