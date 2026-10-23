// Fixes from the security review: printed invites don't prove an address
// (SEC-3), upload budgets (SEC-6) and sign-in lockouts and send budgets (SEC-7).

import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { describe, test } from 'node:test';
import { buildApp } from '../src/app.js';
import { newId } from '../src/lib/ids.js';
import { MAX_FAILED_CODES_PER_DAY } from '../src/lib/login.js';
import { randomToken } from '../src/lib/tokens.js';
import { loginAs, makeTempDir, makeTestApp, makeTestConfig, makeUser, sameOrigin } from './helpers/index.js';

describe('the console email transport (SEC-3)', () => {
  test('an invite it printed asks for a code instead of proving the address', async (t) => {
    const dir = await makeTempDir();
    // No capture box: this config really uses the console transport.
    const config = makeTestConfig(dir, { EMAIL_TRANSPORT: 'console' });
    const app = await buildApp(config);
    const printed = [];
    const log = console.log;
    console.log = (...args) => printed.push(args.join(' '));
    t.after(async () => {
      console.log = log;
      await app.close();
      await fs.rm(dir, { recursive: true, force: true });
    });

    const admin = makeUser(app.db, { role: 'admin' });
    const cookie = loginAs(app, app.db, admin);
    const res = await app.inject({
      method: 'POST',
      url: '/api/admin/invites',
      headers: sameOrigin(cookie),
      payload: { name: 'Sarah', email: 'sarah.printed@example.com', send: true },
    });
    assert.equal(res.statusCode, 201, res.body);
    assert.equal(res.json().sent, false, 'printed is not sent');
    assert.equal(app.db.prepare('SELECT sent_at FROM invites WHERE id = ?').get(res.json().invite.id).sent_at, null);
    assert.equal(printed.length, 1);

    const token = res.json().url.split('/join/')[1];
    const lookup = (await app.inject({ url: `/api/invites/${token}` })).json();
    assert.equal(lookup.emailed, false);
    const accept = await app.inject({
      method: 'POST',
      url: `/api/invites/${token}/accept`,
      headers: sameOrigin(''),
      payload: { name: 'Sarah', email: 'sarah.printed@example.com' },
    });
    assert.equal(accept.statusCode, 200, accept.body);
    assert.equal(accept.json().signed_in, false, 'whoever read the log still needs the code');
  });
});

describe('upload budgets (SEC-6)', () => {
  const TUS = { 'tus-resumable': '1.0.0' };
  const create = (ctx, cookie, length) =>
    ctx.app.inject({ method: 'POST', url: '/api/uploads/', headers: { ...sameOrigin(cookie), ...TUS, 'upload-length': String(length) } });
  const addFinished = (ctx, user, bytes) =>
    ctx.db
      .prepare(
        `INSERT INTO items (id, user_id, kind, status, original_path, original_mime, original_bytes, created_at)
         VALUES (?, ?, 'photo', 'ready', 'originals/x.jpg', 'image/jpeg', ?, ?)`,
      )
      .run(newId(), user.id, bytes, Date.now());

  test("a day's files and bytes per person, then a kind 429", async (t) => {
    const ctx = await makeTestApp({ routeOptions: { uploadLimits: { filesPerDay: 2, bytesPerDay: 1000 } } });
    t.after(ctx.cleanup);
    const user = makeUser(ctx.db);
    const cookie = loginAs(ctx.app, ctx.db, user);
    assert.equal((await create(ctx, cookie, 400)).statusCode, 201);
    addFinished(ctx, user, 700);
    const tooBig = await create(ctx, cookie, 400);
    assert.equal(tooBig.statusCode, 429, '700 + 400 is over the 1000-byte day');
    assert.match(tooBig.body, /send the rest tomorrow/);
    addFinished(ctx, user, 1);
    assert.equal((await create(ctx, cookie, 1)).statusCode, 429, 'two files is the day');
    // someone else has their own budget
    assert.equal((await create(ctx, loginAs(ctx.app, ctx.db, makeUser(ctx.db)), 400)).statusCode, 201);
  });

  test('a free-space floor on the drive', async (t) => {
    const ctx = await makeTestApp({ routeOptions: { uploadLimits: { minFreeBytes: Number.MAX_SAFE_INTEGER } } });
    t.after(ctx.cleanup);
    const res = await create(ctx, loginAs(ctx.app, ctx.db, makeUser(ctx.db)), 10);
    assert.equal(res.statusCode, 507);
    assert.match(res.body, /nearly full/);
  });
});

describe('sign-in code lockout (SEC-7)', () => {
  test('after a day of wrong codes, no code is sent or accepted for that email', async (t) => {
    const ctx = await makeTestApp();
    t.after(ctx.cleanup);
    const user = makeUser(ctx.db);
    const request = () =>
      ctx.app.inject({ method: 'POST', url: '/api/auth/code/request', headers: sameOrigin(''), payload: { email: user.email }, remoteAddress: '10.9.0.1' });
    assert.equal((await request()).statusCode, 200);
    const code = /sign-in code is (\d{6})/.exec(ctx.mail.at(-1).text)[1];

    // Earlier today: three codes, each tried and missed five times.
    for (let i = 0; i < MAX_FAILED_CODES_PER_DAY / 5; i++) {
      ctx.db
        .prepare(
          `INSERT INTO login_codes (id, user_id, code_hash, link_token_hash, expires_at, attempts, used_at, created_at, ip)
           VALUES (?, ?, 'x', ?, ?, 5, NULL, ?, NULL)`,
        )
        .run(newId(Date.now() - 60_000 * (i + 2)), user.id, randomToken(16), Date.now() - 1, Date.now() - 60_000 * (i + 2));
    }
    const verify = await ctx.app.inject({
      method: 'POST',
      url: '/api/auth/code/verify',
      headers: sameOrigin(''),
      payload: { email: user.email, code },
      remoteAddress: '10.9.0.2',
    });
    assert.equal(verify.statusCode, 400, 'even the right code waits until tomorrow');
    assert.equal(verify.json().error.code, 'invalid_code');

    const mailed = ctx.mail.length;
    assert.equal((await request()).statusCode, 200, 'the answer never changes');
    assert.equal(ctx.mail.length, mailed, 'but no code goes out');
  });
});
