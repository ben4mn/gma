// Web push: lib/push.js (who gets what, payloads, failure bookkeeping) and the
// /api/push/* routes. web-push's sendNotification is never called: every test
// injects a sender.

import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { after, before, beforeEach, describe, test } from 'node:test';
import webpush from 'web-push';
import { newId } from '../src/lib/ids.js';
import {
  grandmaEventPayload,
  MAX_FAILURES,
  notifyGrandmaEvent,
  PUSH_TTL_SECONDS,
  sendToAll,
  sendToUser,
} from '../src/lib/push.js';
import { isPushServiceUrl } from '../src/routes/push.js';
import { loginAs, loginAsDevice, makeDevice, makeTestApp, makeUser, sameOrigin } from './helpers/index.js';

const vapid = webpush.generateVAPIDKeys();
const PUSH_ENV = {
  VAPID_PUBLIC_KEY: vapid.publicKey,
  VAPID_PRIVATE_KEY: vapid.privateKey,
  VAPID_SUBJECT: 'mailto:ben@example.com',
};
const PRESET_CALL_ME = '01M5GEGM00FFBC4TAMAWYG9Q1W';

function fakeSubscription(host = 'fcm.googleapis.com') {
  return {
    endpoint: `https://${host}/push/${randomBytes(12).toString('base64url')}`,
    keys: {
      p256dh: Buffer.concat([Buffer.from([4]), randomBytes(64)]).toString('base64url'),
      auth: randomBytes(16).toString('base64url'),
    },
  };
}

function addSubscription(db, user, overrides = {}) {
  const sub = fakeSubscription();
  const id = newId();
  db.prepare(
    `INSERT INTO push_subscriptions (id, user_id, endpoint, p256dh, auth, created_at, failures)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(id, user.id, sub.endpoint, sub.keys.p256dh, sub.keys.auth, Date.now(), overrides.failures ?? 0);
  return { id, ...sub };
}

// A sender that records every call; `fail` maps an endpoint to the status code to fail with.
function recordingSender(fail = new Map()) {
  const calls = [];
  const sender = async (subscription, body, options) => {
    calls.push({ endpoint: subscription.endpoint, keys: subscription.keys, payload: JSON.parse(body), options });
    const status = fail.get(subscription.endpoint);
    if (status) throw Object.assign(new Error(`Received unexpected response code ${status}`), { statusCode: status });
    return { statusCode: 201 };
  };
  return { calls, sender, fail };
}

function makeItem(db, user, overrides = {}) {
  const at = Date.now();
  const item = { id: newId(at), kind: 'photo', caption: null, ...overrides };
  db.prepare(
    `INSERT INTO items (id, user_id, kind, caption, status, created_at, ready_at)
     VALUES (?, ?, ?, ?, 'ready', ?, ?)`,
  ).run(item.id, user.id, item.kind, item.caption, at, at);
  return item;
}

function makeEvent(db, device, fields) {
  const id = newId();
  db.prepare(
    `INSERT INTO grandma_events (id, device_id, kind, item_id, reaction, preset_id, preset_text, voice_note_id,
                                 recipient_user_id, client_id, created_at)
     VALUES (@id, @device_id, @kind, @item_id, @reaction, @preset_id, @preset_text, @voice_note_id,
             @recipient_user_id, @client_id, @created_at)`,
  ).run({
    id,
    device_id: device.id,
    item_id: null,
    reaction: null,
    preset_id: null,
    preset_text: null,
    voice_note_id: null,
    recipient_user_id: null,
    client_id: newId(),
    created_at: Date.now(),
    ...fields,
  });
  return id;
}

function makeVoiceNote(db, device, durationMs) {
  const id = newId();
  db.prepare(
    `INSERT INTO voice_notes (id, device_id, status, duration_ms, audio_path, created_at)
     VALUES (?, ?, 'ready', ?, ?, ?)`,
  ).run(id, device.id, durationMs, `renditions/${id}/audio.m4a`, Date.now());
  return id;
}

describe('notifyGrandmaEvent: who gets what', () => {
  let t;
  let device;
  let sarah;
  let mike;
  let pending;
  let removed;
  const subs = {};

  before(async () => {
    t = await makeTestApp({ env: PUSH_ENV });
    device = makeDevice(t.db);
    sarah = makeUser(t.db, { name: 'Sarah' });
    mike = makeUser(t.db, { name: 'Mike' });
    pending = makeUser(t.db, { name: 'Pat', status: 'pending', activated_at: null });
    removed = makeUser(t.db, { name: 'Rex', status: 'removed', removed_at: Date.now() });
    subs.sarahPhone = addSubscription(t.db, sarah);
    subs.sarahLaptop = addSubscription(t.db, sarah);
    subs.mike = addSubscription(t.db, mike);
    subs.pending = addSubscription(t.db, pending);
    subs.removed = addSubscription(t.db, removed);
  });
  after(() => t.cleanup());

  test('a reaction goes to the photo’s owner only, on every phone they have', async () => {
    const item = makeItem(t.db, sarah, { caption: 'Lily at the farm' });
    const eventId = makeEvent(t.db, device, { kind: 'reaction', item_id: item.id, reaction: 'love', recipient_user_id: sarah.id });
    const push = recordingSender();
    const result = await notifyGrandmaEvent(t.db, t.config, eventId, { sender: push.sender });

    assert.deepEqual(result, { recipients: 1, sent: 2, failed: 0, removed: 0 });
    assert.deepEqual(push.calls.map((c) => c.endpoint).sort(), [subs.sarahPhone.endpoint, subs.sarahLaptop.endpoint].sort());
    for (const call of push.calls) {
      assert.deepEqual(call.payload, {
        web_push: 8030,
        notification: {
          title: 'Grandma loved your photo',
          body: '❤️ Love · “Lily at the farm”',
          navigate: `http://localhost:8080/from-grandma#e-${eventId}`,
          tag: `grandma-${item.id}`,
        },
      });
      assert.equal(call.options.TTL, PUSH_TTL_SECONDS);
      assert.equal(call.options.TTL, 172_800);
      assert.equal(call.options.urgency, 'normal');
      assert.deepEqual(call.options.vapidDetails, {
        subject: 'mailto:ben@example.com',
        publicKey: vapid.publicKey,
        privateKey: vapid.privateKey,
      });
    }
  });

  test('a preset goes to the photo’s owner only', async () => {
    const item = makeItem(t.db, mike);
    const eventId = makeEvent(t.db, device, {
      kind: 'preset',
      item_id: item.id,
      preset_id: PRESET_CALL_ME,
      preset_text: 'Call me',
      recipient_user_id: mike.id,
    });
    const push = recordingSender();
    await notifyGrandmaEvent(t.db, t.config, eventId, { sender: push.sender });
    assert.deepEqual(push.calls.map((c) => c.endpoint), [subs.mike.endpoint]);
    assert.deepEqual(push.calls[0].payload.notification, {
      title: 'Grandma sent you a message',
      body: '“Call me” · about your photo',
      navigate: `http://localhost:8080/from-grandma#e-${eventId}`,
      tag: `grandma-message-${eventId}`,
    });
    assert.notEqual(push.calls[0].payload.notification.tag, `grandma-${item.id}`, 'a later reaction never replaces it (F13)');
  });

  test('a voice note goes to every active person, nobody pending or removed', async () => {
    const voiceId = makeVoiceNote(t.db, device, 42_000);
    const eventId = makeEvent(t.db, device, { kind: 'voice', voice_note_id: voiceId });
    const push = recordingSender();
    const result = await notifyGrandmaEvent(t.db, t.config, eventId, { sender: push.sender });
    assert.equal(result.recipients, 2);
    assert.deepEqual(
      push.calls.map((c) => c.endpoint).sort(),
      [subs.sarahPhone.endpoint, subs.sarahLaptop.endpoint, subs.mike.endpoint].sort(),
    );
    assert.deepEqual(push.calls[0].payload, {
      web_push: 8030,
      notification: {
        title: 'Grandma sent a voice message',
        body: 'Tap to listen (0:42)',
        navigate: `http://localhost:8080/from-grandma#e-${eventId}`,
        tag: `grandma-voice-${eventId}`,
      },
    });
  });

  test('a reaction to a removed person’s photo pushes to nobody', async () => {
    const item = makeItem(t.db, removed);
    const eventId = makeEvent(t.db, device, { kind: 'reaction', item_id: item.id, reaction: 'wow', recipient_user_id: removed.id });
    const push = recordingSender();
    const result = await notifyGrandmaEvent(t.db, t.config, eventId, { sender: push.sender });
    assert.equal(push.calls.length, 0);
    assert.equal(result.sent, 0);
  });

  test('an unknown event is a no-op', async () => {
    const push = recordingSender();
    assert.equal(await notifyGrandmaEvent(t.db, t.config, newId(), { sender: push.sender }), null);
    assert.equal(push.calls.length, 0);
  });
});

describe('grandmaEventPayload', () => {
  const config = { publicOrigin: 'https://gma.4mn.org' };
  const base = { id: 'E1', item_id: 'I1', item_kind: 'photo' };

  test('each reaction reads naturally, with or without a caption', () => {
    const title = (reaction, extra = {}) => grandmaEventPayload(config, { ...base, kind: 'reaction', reaction, ...extra }).notification;
    assert.equal(title('love').title, 'Grandma loved your photo');
    assert.equal(title('love').body, '❤️ Love');
    assert.equal(title('funny', { item_kind: 'video' }).title, 'Grandma found your video funny');
    assert.equal(title('wow').title, 'Grandma said wow to your photo');
    assert.equal(title('thankful').body, '🙏 Thankful');
    assert.equal(title('thankful').navigate, 'https://gma.4mn.org/from-grandma#e-E1');
  });

  test('a voice note without a known length still invites a listen', () => {
    const n = grandmaEventPayload(config, { id: 'E2', kind: 'voice', voice_duration_ms: null }).notification;
    assert.equal(n.body, 'Tap to listen');
    assert.equal(grandmaEventPayload(config, { id: 'E3', kind: 'voice', voice_duration_ms: 65_400 }).notification.body, 'Tap to listen (1:05)');
  });

  test('a long caption stays well under the 2 KB payload limit', () => {
    const payload = grandmaEventPayload(config, { ...base, kind: 'reaction', reaction: 'love', item_caption: 'x'.repeat(5000) });
    assert.ok(Buffer.byteLength(JSON.stringify(payload)) < 2048);
  });
});

describe('sendToUser / sendToAll bookkeeping', () => {
  let t;
  let user;
  before(async () => {
    t = await makeTestApp({ env: PUSH_ENV });
  });
  after(() => t.cleanup());
  beforeEach(() => {
    t.db.prepare('DELETE FROM push_subscriptions').run();
    user = makeUser(t.db);
  });

  const row = (id) => t.db.prepare('SELECT * FROM push_subscriptions WHERE id = ?').get(id);
  const payload = { web_push: 8030, notification: { title: 'Hi', body: 'There', navigate: 'http://localhost:8080/' } };

  test('a success resets failures and stamps last_success_at', async () => {
    const sub = addSubscription(t.db, user, { failures: 3 });
    const push = recordingSender();
    const result = await sendToUser(t.db, t.config, user.id, payload, { sender: push.sender });
    assert.deepEqual(result, { recipients: 1, sent: 1, failed: 0, removed: 0 });
    assert.equal(row(sub.id).failures, 0);
    assert.ok(row(sub.id).last_success_at);
    assert.deepEqual(push.calls[0].keys, sub.keys);
  });

  test('404 and 410 delete the subscription at once', async () => {
    const gone = addSubscription(t.db, user);
    const missing = addSubscription(t.db, user);
    const fine = addSubscription(t.db, user);
    const push = recordingSender(new Map([[gone.endpoint, 410], [missing.endpoint, 404]]));
    const result = await sendToUser(t.db, t.config, user.id, payload, { sender: push.sender });
    assert.deepEqual(result, { recipients: 1, sent: 1, failed: 2, removed: 2 });
    assert.equal(row(gone.id), undefined);
    assert.equal(row(missing.id), undefined);
    assert.ok(row(fine.id));
  });

  test('other failures count up, and the fifth in a row drops it', async () => {
    const flaky = addSubscription(t.db, user);
    const push = recordingSender(new Map([[flaky.endpoint, 500]]));
    for (let i = 1; i < MAX_FAILURES; i++) {
      await sendToUser(t.db, t.config, user.id, payload, { sender: push.sender });
      assert.equal(row(flaky.id).failures, i);
    }
    const last = await sendToUser(t.db, t.config, user.id, payload, { sender: push.sender });
    assert.equal(last.removed, 1);
    assert.equal(row(flaky.id), undefined);
  });

  test('a network error (no status) counts as a failure, never a crash', async () => {
    const sub = addSubscription(t.db, user);
    const sender = async () => {
      throw new Error('getaddrinfo ENOTFOUND');
    };
    const result = await sendToAll(t.db, t.config, payload, { sender });
    assert.equal(result.failed, 1);
    assert.equal(row(sub.id).failures, 1);
  });

  test('without VAPID keys nothing is sent', async () => {
    const bare = await makeTestApp();
    try {
      const someone = makeUser(bare.db);
      addSubscription(bare.db, someone);
      const push = recordingSender();
      const result = await sendToUser(bare.db, bare.config, someone.id, payload, { sender: push.sender });
      assert.equal(result.sent, 0);
      assert.equal(push.calls.length, 0);
    } finally {
      await bare.cleanup();
    }
  });
});

describe('isPushServiceUrl', () => {
  test('accepts the browsers’ push services and nothing else', () => {
    for (const ok of [
      'https://fcm.googleapis.com/fcm/send/abc',
      'https://web.push.apple.com/QGx',
      'https://updates.push.services.mozilla.com/wpush/v2/x',
      'https://wns2-par02p.notify.windows.com/w/?token=x',
    ]) {
      assert.equal(isPushServiceUrl(ok), true, ok);
    }
    for (const bad of [
      'http://fcm.googleapis.com/fcm/send/abc',
      'https://localhost/push',
      'https://127.0.0.1/push',
      'https://evilpush.apple.com.example.com/x',
      'https://fcm.googleapis.com:8443/x',
      'https://user:pw@fcm.googleapis.com/x',
      'not a url',
    ]) {
      assert.equal(isPushServiceUrl(bad), false, bad);
    }
  });
});

describe('/api/push routes', () => {
  let t;
  let user;
  let cookie;
  const push = recordingSender();

  before(async () => {
    t = await makeTestApp({ env: PUSH_ENV, routeOptions: { pushSender: push.sender } });
    user = makeUser(t.db);
    cookie = loginAs(t.app, t.db, user);
  });
  after(() => t.cleanup());

  const subsFor = (u) => t.db.prepare('SELECT * FROM push_subscriptions WHERE user_id = ?').all(u.id);

  test('every route needs a family member (not a frame)', async () => {
    const frame = loginAsDevice(t.app, t.db, makeDevice(t.db));
    for (const c of [null, frame]) {
      for (const [method, url] of [
        ['GET', '/api/push/key'],
        ['POST', '/api/push/subscribe'],
        ['POST', '/api/push/unsubscribe'],
        ['POST', '/api/push/test'],
      ]) {
        const res = await t.app.inject({ method, url, headers: sameOrigin(c), payload: method === 'POST' ? {} : undefined });
        assert.equal(res.statusCode, 401, `${method} ${url}`);
      }
    }
  });

  test('GET /api/push/key returns the VAPID public key', async () => {
    const res = await t.app.inject({ method: 'GET', url: '/api/push/key', headers: { cookie } });
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.json(), { key: vapid.publicKey });
  });

  test('test without a subscription says so', async () => {
    const res = await t.app.inject({ method: 'POST', url: '/api/push/test', headers: sameOrigin(cookie) });
    assert.equal(res.statusCode, 409);
    assert.equal(res.json().error.code, 'no_subscription');
  });

  test('subscribe stores the subscription, and again updates it in place', async () => {
    const sub = fakeSubscription('web.push.apple.com');
    const res = await t.app.inject({
      method: 'POST',
      url: '/api/push/subscribe',
      headers: sameOrigin(cookie, { 'user-agent': 'iPhone test' }),
      payload: sub,
    });
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.json(), { ok: true });
    let rows = subsFor(user);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].endpoint, sub.endpoint);
    assert.equal(rows[0].p256dh, sub.keys.p256dh);
    assert.equal(rows[0].user_agent, 'iPhone test');

    const newKeys = fakeSubscription().keys;
    t.db.prepare('UPDATE push_subscriptions SET failures = 3').run();
    await t.app.inject({
      method: 'POST',
      url: '/api/push/subscribe',
      headers: sameOrigin(cookie),
      payload: { endpoint: sub.endpoint, keys: newKeys },
    });
    rows = subsFor(user);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].auth, newKeys.auth);
    assert.equal(rows[0].failures, 0);
  });

  test('test sends to this person’s phones', async () => {
    push.calls.length = 0;
    const res = await t.app.inject({ method: 'POST', url: '/api/push/test', headers: sameOrigin(cookie) });
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.json(), { ok: true, sent: 1, failed: 0 });
    assert.equal(push.calls.length, 1);
    assert.equal(push.calls[0].payload.web_push, 8030);
    assert.equal(push.calls[0].payload.notification.title, 'Notifications are on');
    assert.equal(push.calls[0].payload.notification.navigate, 'http://localhost:8080/you');
  });

  test('a phone that changes hands moves to whoever subscribed last', async () => {
    const other = makeUser(t.db);
    const otherCookie = loginAs(t.app, t.db, other);
    const [mine] = subsFor(user);
    const res = await t.app.inject({
      method: 'POST',
      url: '/api/push/subscribe',
      headers: sameOrigin(otherCookie),
      payload: { endpoint: mine.endpoint, keys: { p256dh: mine.p256dh, auth: mine.auth } },
    });
    assert.equal(res.statusCode, 200);
    assert.equal(subsFor(user).length, 0);
    assert.equal(subsFor(other).length, 1);

    // Only the owner can unsubscribe it.
    const notTheirs = await t.app.inject({
      method: 'POST',
      url: '/api/push/unsubscribe',
      headers: sameOrigin(cookie),
      payload: { endpoint: mine.endpoint },
    });
    assert.deepEqual(notTheirs.json(), { ok: true, removed: 0 });
    const theirs = await t.app.inject({
      method: 'POST',
      url: '/api/push/unsubscribe',
      headers: sameOrigin(otherCookie),
      payload: { endpoint: mine.endpoint },
    });
    assert.deepEqual(theirs.json(), { ok: true, removed: 1 });
    assert.equal(subsFor(other).length, 0);
  });

  test('subscribe refuses unknown push services and malformed keys', async () => {
    const good = fakeSubscription();
    const cases = [
      [{ ...good, endpoint: 'https://internal.example/hook' }, 'unsupported_push_service'],
      [{ ...good, endpoint: 'http://fcm.googleapis.com/x' }, 'unsupported_push_service'],
      [{ endpoint: good.endpoint, keys: { p256dh: 'short', auth: good.keys.auth } }, 'bad_subscription'],
      [{ endpoint: good.endpoint, keys: { p256dh: good.keys.p256dh, auth: 'a+b/c' } }, 'bad_subscription'],
      [{ endpoint: good.endpoint }, 'bad_subscription'],
      [{}, 'bad_subscription'],
    ];
    for (const [payload, code] of cases) {
      const res = await t.app.inject({ method: 'POST', url: '/api/push/subscribe', headers: sameOrigin(cookie), payload });
      assert.equal(res.statusCode, 400, JSON.stringify(payload));
      assert.equal(res.json().error.code, code);
    }
  });

  test('a person keeps at most 10 subscriptions; the oldest go first', async () => {
    const someone = makeUser(t.db);
    const c = loginAs(t.app, t.db, someone);
    const endpoints = [];
    for (let i = 0; i < 12; i++) {
      const sub = fakeSubscription();
      endpoints.push(sub.endpoint);
      await t.app.inject({ method: 'POST', url: '/api/push/subscribe', headers: sameOrigin(c), payload: sub });
    }
    const kept = subsFor(someone).map((r) => r.endpoint);
    assert.equal(kept.length, 10);
    assert.ok(!kept.includes(endpoints[0]) && !kept.includes(endpoints[1]));
  });
});

describe('/api/push without VAPID keys', () => {
  let t;
  before(async () => {
    t = await makeTestApp();
  });
  after(() => t.cleanup());

  test('key and test explain that notifications aren’t set up', async () => {
    const cookie = loginAs(t.app, t.db, makeUser(t.db));
    for (const [method, url] of [
      ['GET', '/api/push/key'],
      ['POST', '/api/push/test'],
    ]) {
      const res = await t.app.inject({ method, url, headers: sameOrigin(cookie) });
      assert.equal(res.statusCode, 409);
      assert.equal(res.json().error.code, 'push_unavailable');
      assert.match(res.json().error.message, /aren't set up/);
    }
  });
});
