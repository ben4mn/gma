// Family sign-in without passkeys: email codes, the /confirm link, invites,
// /api/me, the passkey offer count, sign-out and removed people.

import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { after, afterEach, before, describe, test } from 'node:test';
import { newId } from '../src/lib/ids.js';
import { setClock } from '../src/lib/time.js';
import { randomToken, sha256 } from '../src/lib/tokens.js';
import { loginAs, makeTempDir, makeTestApp, makeUser, makeWebFixture, sameOrigin } from './helpers/index.js';

const INVALID_CODE_MESSAGE =
  "That code didn't work. Codes last 15 minutes and only the newest one works, so you can ask for a new one.";

function cookieJar(initial = '') {
  const jar = new Map();
  for (const pair of initial.split('; ').filter(Boolean)) {
    const at = pair.indexOf('=');
    jar.set(pair.slice(0, at), pair.slice(at + 1));
  }
  return {
    take(res) {
      for (const c of res.cookies) {
        const expired = c.value === '' || c.maxAge === 0 || (c.expires && c.expires.getTime() <= Date.now());
        if (expired) jar.delete(c.name);
        else jar.set(c.name, c.value);
      }
      return res;
    },
    get: (name) => jar.get(name),
    set: (name, value) => jar.set(name, value),
    delete: (name) => jar.delete(name),
    header: () => [...jar].map(([k, v]) => `${k}=${v}`).join('; '),
  };
}

// What the person reads in the sign-in email.
function readCodeEmail(message) {
  return {
    code: /sign-in code is (\d{6})/.exec(message.text)[1],
    linkToken: /\/confirm\?t=([A-Za-z0-9_-]+)/.exec(message.text)[1],
  };
}

function makeInvite(db, { name = 'Aunt May', email = 'may@example.com', sent = true, role = 'member', ...rest } = {}) {
  const token = randomToken(32);
  const at = Date.now();
  const row = {
    id: newId(),
    token_hash: sha256(token),
    created_by: null,
    name,
    email,
    role,
    sent_at: sent ? at : null,
    expires_at: at + 14 * 24 * 3600 * 1000,
    used_at: null,
    used_by: null,
    revoked_at: null,
    created_at: at,
    ...rest,
  };
  db.prepare(
    `INSERT INTO invites (id, token_hash, created_by, name, email, role, sent_at, expires_at, used_at, used_by, revoked_at, created_at)
     VALUES (@id, @token_hash, @created_by, @name, @email, @role, @sent_at, @expires_at, @used_at, @used_by, @revoked_at, @created_at)`,
  ).run(row);
  return { ...row, token };
}

let ipCounter = 0;
const freshIp = () => `10.0.${Math.floor(++ipCounter / 250)}.${ipCounter % 250}`;

describe('sign-in', () => {
  let t;
  let webTemp;
  before(async () => {
    webTemp = await makeTempDir();
    const webDir = await makeWebFixture(webTemp);
    t = await makeTestApp({ env: { WEB_DIR: webDir } });
  });
  after(async () => {
    await t.cleanup();
    await fs.rm(webTemp, { recursive: true, force: true });
  });
  afterEach(() => setClock());

  async function post(jar, url, payload, { ip = '127.0.0.1' } = {}) {
    return jar.take(
      await t.app.inject({ method: 'POST', url, headers: sameOrigin(jar.header()), payload, remoteAddress: ip }),
    );
  }

  const mailTo = (email) => t.mail.filter((m) => m.to === email);

  async function requestCode(email, opts) {
    const before = mailTo(email).length;
    const res = await post(cookieJar(), '/api/auth/code/request', { email }, opts);
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.json(), { ok: true });
    const mail = mailTo(email);
    return mail.length > before ? readCodeEmail(mail.at(-1)) : null;
  }

  describe('email codes', () => {
    test('a code request always answers 200 and only mails real people', async () => {
      const user = makeUser(t.db, { name: 'Mike' });
      const res = await post(cookieJar(), '/api/auth/code/request', { email: ` ${user.email.toUpperCase()} ` });
      assert.equal(res.statusCode, 200);
      assert.equal(mailTo(user.email).length, 1, 'the email is matched without regard to case or spaces');
      const message = mailTo(user.email).at(-1);
      const emailed = readCodeEmail(message);
      assert.match(message.subject, /^\d{6} is your code/);
      assert.match(message.text, /^Hi Mike,/);
      assert.ok(message.text.includes(`http://localhost:8080/confirm?t=${emailed.linkToken}`));

      const row = t.db.prepare('SELECT * FROM login_codes WHERE user_id = ?').get(user.id);
      assert.notEqual(row.code_hash, emailed.code, 'only an HMAC is stored');
      assert.ok(!row.code_hash.includes(emailed.code));
      assert.equal(row.link_token_hash, sha256(emailed.linkToken));
      assert.equal(row.expires_at - row.created_at, 15 * 60 * 1000);

      const count = t.mail.length;
      assert.equal(await requestCode('nobody-here@example.com'), null);
      assert.equal(t.mail.length, count);
    });

    test('a malformed email is a kind 400', async () => {
      const res = await post(cookieJar(), '/api/auth/code/request', { email: 'not an email' });
      assert.equal(res.statusCode, 400);
      assert.equal(res.json().error.code, 'invalid_email');
      assert.match(res.json().error.message, /like name@example.com/);
    });

    test('the right code signs in once and offers a passkey', async () => {
      const user = makeUser(t.db);
      const { code } = await requestCode(user.email);
      const jar = cookieJar();
      const res = await post(jar, '/api/auth/code/verify', { email: user.email, code: `${code.slice(0, 3)} ${code.slice(3)}` });
      assert.equal(res.statusCode, 200, res.body);
      assert.equal(res.headers['cache-control'], 'no-store');
      assert.deepEqual(res.json().user, {
        id: user.id,
        name: user.name,
        email: user.email,
        role: 'member',
        status: 'active',
        color: null,
      });
      assert.equal(res.json().offer_passkey, true);
      const setCookie = res.cookies.find((c) => c.name === 'gma_session');
      assert.equal(setCookie.httpOnly, true);
      assert.equal(setCookie.sameSite, 'Lax');
      assert.equal(setCookie.maxAge, 34_560_000);

      const me = await t.app.inject({ url: '/api/me', headers: { cookie: jar.header() } });
      assert.equal(me.statusCode, 200);
      assert.equal(me.json().offer_passkey, false, 'one offer per session');

      const reuse = await post(cookieJar(), '/api/auth/code/verify', { email: user.email, code });
      assert.equal(reuse.statusCode, 400);
      assert.equal(reuse.json().error.message, INVALID_CODE_MESSAGE);
    });

    test('a code that is not 6 numbers gets its own hint', async () => {
      const res = await post(cookieJar(), '/api/auth/code/verify', { email: 'a@example.com', code: '12a' });
      assert.equal(res.statusCode, 400);
      assert.equal(res.json().error.message, 'Please type the 6 numbers from the email.');
    });

    test('five wrong tries use the code up, with the same answer as a stranger gets', async () => {
      const user = makeUser(t.db);
      const { code } = await requestCode(user.email);
      const wrong = code === '000000' ? '111111' : '000000';
      for (let i = 0; i < 5; i++) {
        const res = await post(cookieJar(), '/api/auth/code/verify', { email: user.email, code: wrong });
        assert.equal(res.statusCode, 400);
        assert.equal(res.json().error.message, INVALID_CODE_MESSAGE);
      }
      const right = await post(cookieJar(), '/api/auth/code/verify', { email: user.email, code });
      assert.equal(right.statusCode, 400);
      assert.equal(right.json().error.code, 'invalid_code');
      assert.equal(t.db.prepare('SELECT attempts FROM login_codes WHERE user_id = ?').get(user.id).attempts, 5);

      const stranger = await post(cookieJar(), '/api/auth/code/verify', { email: 'stranger@example.com', code });
      assert.deepEqual(stranger.json(), right.json());
    });

    test('a code expires after 15 minutes', async () => {
      const user = makeUser(t.db);
      const { code } = await requestCode(user.email);
      const later = Date.now() + 15 * 60 * 1000 + 1000;
      setClock(() => later);
      const res = await post(cookieJar(), '/api/auth/code/verify', { email: user.email, code });
      assert.equal(res.statusCode, 400);
    });

    test('the newest code wins: the older code and link stop working', async () => {
      const user = makeUser(t.db);
      const first = await requestCode(user.email);
      const second = await requestCode(user.email);
      assert.equal((await post(cookieJar(), '/api/auth/code/verify', { email: user.email, code: first.code })).statusCode, 400);
      assert.equal((await post(cookieJar(), '/api/auth/link/confirm', { token: first.linkToken })).statusCode, 400);
      assert.equal((await post(cookieJar(), '/api/auth/code/verify', { email: user.email, code: second.code })).statusCode, 200);
    });

    test('five codes per email per hour; the sixth request still says 200 but sends nothing', async () => {
      const user = makeUser(t.db);
      const ip = freshIp();
      for (let i = 0; i < 5; i++) assert.ok(await requestCode(user.email, { ip }));
      assert.equal(await requestCode(user.email, { ip }), null);
      assert.equal(mailTo(user.email).length, 5);

      const later = Date.now() + 61 * 60 * 1000;
      setClock(() => later);
      assert.ok(await requestCode(user.email, { ip }), 'an hour later it works again');
    });

    test('twenty code requests per address per hour, whoever they are for', async () => {
      const ip = freshIp();
      for (let i = 0; i < 20; i++) {
        const res = await post(cookieJar(), '/api/auth/code/request', { email: `x${i}@example.com` }, { ip });
        assert.equal(res.statusCode, 200);
      }
      const res = await post(cookieJar(), '/api/auth/code/request', { email: 'x21@example.com' }, { ip });
      assert.equal(res.statusCode, 429);
      assert.equal(res.json().error.code, 'rate_limited');
      const other = await post(cookieJar(), '/api/auth/code/request', { email: 'x22@example.com' }, { ip: freshIp() });
      assert.equal(other.statusCode, 200);
    });

    test('a pending person becomes active at their first sign-in', async () => {
      const user = makeUser(t.db, { status: 'pending', activated_at: null });
      const { code } = await requestCode(user.email);
      const res = await post(cookieJar(), '/api/auth/code/verify', { email: user.email, code });
      assert.equal(res.statusCode, 200);
      const row = t.db.prepare('SELECT status, activated_at FROM users WHERE id = ?').get(user.id);
      assert.equal(row.status, 'active');
      assert.ok(row.activated_at > 0);
    });
  });

  describe('the confirm link', () => {
    test('opening /confirm only shows the page; the button signs in, once', async () => {
      const user = makeUser(t.db);
      const { code, linkToken } = await requestCode(user.email);

      const page = await t.app.inject({ url: `/confirm?t=${linkToken}` });
      assert.equal(page.statusCode, 200);
      assert.match(page.body, /family shell/);
      assert.equal(t.db.prepare('SELECT used_at FROM login_codes WHERE user_id = ?').get(user.id).used_at, null);

      const jar = cookieJar();
      const res = await post(jar, '/api/auth/link/confirm', { token: linkToken });
      assert.equal(res.statusCode, 200, res.body);
      assert.equal(res.json().user.id, user.id);
      assert.ok(jar.get('gma_session'));

      const again = await post(cookieJar(), '/api/auth/link/confirm', { token: linkToken });
      assert.equal(again.statusCode, 400);
      assert.equal(again.json().error.code, 'link_expired');
      const codeAfter = await post(cookieJar(), '/api/auth/code/verify', { email: user.email, code });
      assert.equal(codeAfter.statusCode, 400, 'the code from the same email is used up too');
    });

    test('a link still works after someone burned the code tries', async () => {
      const user = makeUser(t.db);
      const { code, linkToken } = await requestCode(user.email);
      const wrong = code === '000000' ? '111111' : '000000';
      for (let i = 0; i < 5; i++) await post(cookieJar(), '/api/auth/code/verify', { email: user.email, code: wrong });
      assert.equal((await post(cookieJar(), '/api/auth/link/confirm', { token: linkToken })).statusCode, 200);
    });

    test('junk and expired links get the same kind answer', async () => {
      const user = makeUser(t.db);
      const { linkToken } = await requestCode(user.email);
      for (const token of [undefined, 'short', randomToken(32)]) {
        const res = await post(cookieJar(), '/api/auth/link/confirm', { token });
        assert.equal(res.statusCode, 400);
        assert.equal(res.json().error.code, 'link_expired');
      }
      const later = Date.now() + 16 * 60 * 1000;
      setClock(() => later);
      assert.equal((await post(cookieJar(), '/api/auth/link/confirm', { token: linkToken })).statusCode, 400);
    });
  });

  describe('removed people', () => {
    test('cannot get a code, use an old code or link, or keep their session', async () => {
      const user = makeUser(t.db);
      const cookie = loginAs(t.app, t.db, user);
      const { code, linkToken } = await requestCode(user.email);
      t.db.prepare("UPDATE users SET status = 'removed', removed_at = ? WHERE id = ?").run(Date.now(), user.id);

      assert.equal(await requestCode(user.email), null);
      assert.equal((await post(cookieJar(), '/api/auth/code/verify', { email: user.email, code })).statusCode, 400);
      assert.equal((await post(cookieJar(), '/api/auth/link/confirm', { token: linkToken })).statusCode, 400);
      assert.equal((await t.app.inject({ url: '/api/me', headers: { cookie } })).statusCode, 401);
    });
  });

  describe('invites', () => {
    test('looking up an invite says whether it can be used, and why not', async () => {
      const ok = makeInvite(t.db, { email: 'lookup@example.com' });
      const res = await t.app.inject({ url: `/api/invites/${ok.token}` });
      assert.equal(res.statusCode, 200);
      assert.deepEqual(res.json(), { valid: true, name: 'Aunt May', email: 'lookup@example.com', emailed: true, reason: null });

      const shared = makeInvite(t.db, { name: null, email: null, sent: false });
      assert.deepEqual((await t.app.inject({ url: `/api/invites/${shared.token}` })).json(), {
        valid: true,
        name: null,
        email: null,
        emailed: false,
        reason: null,
      });

      const cases = {
        unknown: randomToken(32),
        expired: makeInvite(t.db, { expires_at: Date.now() - 1 }).token,
        revoked: makeInvite(t.db, { revoked_at: Date.now() }).token,
        used: makeInvite(t.db, { used_at: Date.now(), used_by: makeUser(t.db).id }).token,
      };
      for (const [reason, token] of Object.entries(cases)) {
        const body = (await t.app.inject({ url: `/api/invites/${token}` })).json();
        assert.deepEqual(body, { valid: false, name: null, email: null, emailed: false, reason }, reason);
      }
    });

    test('an invite the app emailed signs that address straight in, once', async () => {
      const invite = makeInvite(t.db, { name: 'Sarah', email: 'sarah.joins@example.com', role: 'admin' });
      const jar = cookieJar();
      const res = await post(jar, `/api/invites/${invite.token}/accept`, { name: ' Sarah  Lee ', email: 'Sarah.Joins@example.com' });
      assert.equal(res.statusCode, 200, res.body);
      const body = res.json();
      assert.equal(body.signed_in, true);
      assert.equal(body.offer_passkey, true);
      assert.equal(body.user.name, 'Sarah Lee');
      assert.equal(body.user.role, 'admin', 'the role comes from the invite');
      assert.equal(body.user.status, 'active');
      assert.ok(jar.get('gma_session'));
      assert.equal(t.mail.filter((m) => /sarah.joins/i.test(m.to)).length, 0, 'no code needed');

      const row = t.db.prepare('SELECT used_at, used_by FROM invites WHERE id = ?').get(invite.id);
      assert.equal(row.used_by, body.user.id);
      assert.ok(row.used_at > 0);
      assert.equal((await t.app.inject({ url: `/api/invites/${invite.token}` })).json().reason, 'used');
      const again = await post(cookieJar(), `/api/invites/${invite.token}/accept`, { name: 'Sarah', email: 'sarah.joins@example.com' });
      assert.equal(again.statusCode, 410);
      assert.equal(again.json().error.code, 'invite_used');
    });

    test('a shared invite sends a code; a typo can be fixed by opening the link again', async () => {
      const invite = makeInvite(t.db, { name: null, email: null, sent: false });
      const typo = await post(cookieJar(), `/api/invites/${invite.token}/accept`, { name: 'Cousin Jo', email: 'jo@exmaple.com' });
      assert.equal(typo.statusCode, 200, typo.body);
      assert.deepEqual(typo.json(), { signed_in: false, email: 'jo@exmaple.com' });
      assert.equal(mailTo('jo@exmaple.com').length, 1);
      const pending = t.db.prepare('SELECT * FROM users WHERE email = ?').get('jo@exmaple.com');
      assert.equal(pending.status, 'pending');
      assert.equal((await t.app.inject({ url: `/api/invites/${invite.token}` })).json().valid, true);

      const fixed = await post(cookieJar(), `/api/invites/${invite.token}/accept`, { name: 'Cousin Jo', email: 'jo@example.com' });
      assert.equal(fixed.statusCode, 200);
      const user = t.db.prepare('SELECT * FROM users WHERE email = ?').get('jo@example.com');
      assert.equal(user.id, pending.id, 'the same pending person, with the corrected email');

      const { code } = readCodeEmail(mailTo('jo@example.com').at(-1));
      const jar = cookieJar();
      const res = await post(jar, '/api/auth/code/verify', { email: 'jo@example.com', code });
      assert.equal(res.statusCode, 200);
      assert.equal(res.json().user.status, 'active');
      assert.equal((await t.app.inject({ url: `/api/invites/${invite.token}` })).json().reason, 'used');
    });

    test('changing the address on an emailed invite falls back to a code', async () => {
      const invite = makeInvite(t.db, { email: 'grandson@example.com' });
      const res = await post(cookieJar(), `/api/invites/${invite.token}/accept`, { name: 'Ben', email: 'ben.other@example.com' });
      assert.equal(res.statusCode, 200);
      assert.equal(res.json().signed_in, false);
      assert.equal(mailTo('ben.other@example.com').length, 1);
    });

    test("typing an existing person's address sends them a code and leaves the invite alone", async () => {
      const existing = makeUser(t.db);
      const invite = makeInvite(t.db, { name: null, email: null, sent: false });
      const res = await post(cookieJar(), `/api/invites/${invite.token}/accept`, { name: 'Someone', email: existing.email });
      assert.equal(res.statusCode, 200);
      assert.equal(res.json().signed_in, false);
      assert.equal(mailTo(existing.email).length, 1);
      assert.equal(t.db.prepare('SELECT name FROM users WHERE id = ?').get(existing.id).name, existing.name);
      assert.equal(t.db.prepare('SELECT used_at FROM invites WHERE id = ?').get(invite.id).used_at, null);
    });

    test('an emailed invite to someone who already has an account signs them in and is used up', async () => {
      const existing = makeUser(t.db);
      const invite = makeInvite(t.db, { email: existing.email });
      const res = await post(cookieJar(), `/api/invites/${invite.token}/accept`, { name: 'X', email: existing.email });
      assert.equal(res.statusCode, 200);
      assert.equal(res.json().signed_in, true);
      assert.equal(res.json().user.id, existing.id);
      assert.equal(res.json().user.role, 'member', 'an invite never changes an existing role');
      assert.equal((await t.app.inject({ url: `/api/invites/${invite.token}` })).json().reason, 'used');
    });

    test('a removed person cannot come back through an invite', async () => {
      const removed = makeUser(t.db, { status: 'removed', removed_at: Date.now() });
      const invite = makeInvite(t.db, { email: removed.email });
      const res = await post(cookieJar(), `/api/invites/${invite.token}/accept`, { name: 'X', email: removed.email });
      assert.equal(res.statusCode, 403);
      assert.equal(res.json().error.code, 'account_removed');
      assert.equal(t.db.prepare('SELECT status FROM users WHERE id = ?').get(removed.id).status, 'removed');
      assert.equal(t.db.prepare('SELECT used_at FROM invites WHERE id = ?').get(invite.id).used_at, null);
    });

    test('expired, revoked and unknown invites cannot be accepted', async () => {
      const expired = makeInvite(t.db, { expires_at: Date.now() - 1 });
      const revoked = makeInvite(t.db, { revoked_at: Date.now() });
      const payload = { name: 'X', email: 'x-invite@example.com' };
      const e = await post(cookieJar(), `/api/invites/${expired.token}/accept`, payload);
      assert.equal(e.statusCode, 410);
      assert.equal(e.json().error.code, 'invite_expired');
      const r = await post(cookieJar(), `/api/invites/${revoked.token}/accept`, payload);
      assert.equal(r.json().error.code, 'invite_revoked');
      const u = await post(cookieJar(), `/api/invites/${randomToken(32)}/accept`, payload);
      assert.equal(u.statusCode, 404);
      assert.equal(u.json().error.code, 'invite_unknown');
      assert.equal(t.db.prepare('SELECT COUNT(*) AS n FROM users WHERE email = ?').get('x-invite@example.com').n, 0);
    });

    test('a name is required', async () => {
      const invite = makeInvite(t.db, { name: null, email: null, sent: false });
      const res = await post(cookieJar(), `/api/invites/${invite.token}/accept`, { name: '   ', email: 'named@example.com' });
      assert.equal(res.statusCode, 400);
      assert.equal(res.json().error.code, 'invalid_name');
    });
  });

  describe('/api/me and the passkey offer', () => {
    test('says who you are, how many passkeys you have and whether push is on', async () => {
      const user = makeUser(t.db, { color: '#8A3517' });
      const cookie = loginAs(t.app, t.db, user);
      const res = await t.app.inject({ url: '/api/me', headers: { cookie } });
      assert.equal(res.statusCode, 200);
      assert.equal(res.headers['cache-control'], 'no-store');
      const body = res.json();
      assert.equal(body.user.color, '#8A3517');
      assert.equal(body.passkeys, 0);
      assert.equal(body.push, false);
      assert.equal(typeof body.offer_passkey, 'boolean');

      t.db
        .prepare(
          `INSERT INTO push_subscriptions (id, user_id, endpoint, p256dh, auth, created_at) VALUES (?, ?, ?, 'k', 'a', ?)`,
        )
        .run(newId(), user.id, `https://push.example/${user.id}`, Date.now());
      assert.equal((await t.app.inject({ url: '/api/me', headers: { cookie } })).json().push, true);
      assert.equal((await t.app.inject({ url: '/api/me' })).statusCode, 401);
    });

    test('a device is offered a passkey at most three times, once per sign-in', async () => {
      const user = makeUser(t.db);
      const jar = cookieJar();
      const offers = [];
      for (let i = 0; i < 4; i++) {
        const { code } = await requestCode(user.email, { ip: freshIp() });
        const res = await post(jar, '/api/auth/code/verify', { email: user.email, code });
        offers.push(res.json().offer_passkey);
      }
      assert.deepEqual(offers, [true, true, true, false]);

      // Another phone starts its own count.
      const { code } = await requestCode(user.email, { ip: freshIp() });
      const otherPhone = await post(cookieJar(), '/api/auth/code/verify', { email: user.email, code });
      assert.equal(otherPhone.json().offer_passkey, true);
    });

    test('an older session is offered once on /api/me, then not again', async () => {
      const user = makeUser(t.db);
      const jar = cookieJar(loginAs(t.app, t.db, user));
      const first = jar.take(await t.app.inject({ url: '/api/me', headers: { cookie: jar.header() } }));
      const second = jar.take(await t.app.inject({ url: '/api/me', headers: { cookie: jar.header() } }));
      assert.equal(first.json().offer_passkey, true);
      assert.equal(second.json().offer_passkey, false);
    });

    test('a device that has a passkey is never offered one', async () => {
      const user = makeUser(t.db);
      const jar = cookieJar('gma_passkey_offers=done');
      const { code } = await requestCode(user.email, { ip: freshIp() });
      const res = await post(jar, '/api/auth/code/verify', { email: user.email, code });
      assert.equal(res.json().offer_passkey, false);
    });
  });

  describe('sign-out', () => {
    test('ends this session only and clears the cookie', async () => {
      const user = makeUser(t.db);
      const cookie = loginAs(t.app, t.db, user);
      const jar = cookieJar(cookie);
      const otherPhone = loginAs(t.app, t.db, user);
      const res = await post(jar, '/api/auth/logout');
      assert.equal(res.statusCode, 200);
      assert.deepEqual(res.json(), { ok: true });
      assert.equal(jar.get('gma_session'), undefined);
      const stale = await t.app.inject({ url: '/api/me', headers: { cookie } });
      assert.equal(stale.statusCode, 401);
      assert.equal((await t.app.inject({ url: '/api/me', headers: { cookie: otherPhone } })).statusCode, 200);
      assert.equal((await post(cookieJar(), '/api/auth/logout')).statusCode, 401);
    });

    test('signing in as someone else on the same browser ends the old session', async () => {
      const first = makeUser(t.db);
      const second = makeUser(t.db);
      const firstCookie = loginAs(t.app, t.db, first);
      const jar = cookieJar(firstCookie);
      const { code } = await requestCode(second.email, { ip: freshIp() });
      await post(jar, '/api/auth/code/verify', { email: second.email, code });
      assert.equal((await t.app.inject({ url: '/api/me', headers: { cookie: firstCookie } })).statusCode, 401);
      assert.equal((await t.app.inject({ url: '/api/me', headers: { cookie: jar.header() } })).json().user.id, second.id);
    });
  });
});
