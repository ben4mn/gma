// Grandma's frame: pairing, device auth, state, seen, reactions, presets,
// voice uploads and the heartbeat.

import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import { after, before, beforeEach, describe, test } from 'node:test';
import webpush from 'web-push';
import { newId } from '../src/lib/ids.js';
import { setSetting } from '../src/lib/settings.js';
import { groupIntoCards } from '../src/routes/frame.js';
import { loginAs, loginAsDevice, makeDevice, makeTestApp, makeUser, sameOrigin } from './helpers/index.js';

const PRESET_CALL_ME = '01M5GEGM00FFBC4TAMAWYG9Q1W';
const MINUTE = 60_000;

// ---------------------------------------------------------------------------
// Fixtures

let clock = Date.now() - 60 * MINUTE;

// A ready item with the renditions the worker would have made.
function makeItem(db, user, overrides = {}) {
  clock += 1000;
  const createdAt = overrides.created_at ?? clock;
  const item = {
    id: newId(createdAt),
    user_id: user.id,
    kind: 'photo',
    caption: null,
    batch_id: null,
    status: 'ready',
    width: 1600,
    height: 1200,
    duration_ms: null,
    created_at: createdAt,
    ready_at: createdAt + 500,
    ...overrides,
  };
  db.prepare(
    `INSERT INTO items (id, user_id, kind, caption, batch_id, status, width, height, duration_ms, created_at, ready_at)
     VALUES (@id, @user_id, @kind, @caption, @batch_id, @status, @width, @height, @duration_ms, @created_at, @ready_at)`,
  ).run(item);
  const names = item.kind === 'photo' ? ['thumb', 'display', 'large'] : ['thumb', 'poster', 'video'];
  for (const name of names) {
    db.prepare(
      'INSERT INTO renditions (item_id, name, path, mime, width, height, bytes) VALUES (?, ?, ?, ?, ?, ?, ?)',
    ).run(item.id, name, `renditions/${item.id}/${name}.jpg`, 'image/jpeg', item.width, item.height, 1000);
  }
  return item;
}

function fakeSubscription() {
  return {
    endpoint: `https://fcm.googleapis.com/fcm/send/${randomBytes(12).toString('base64url')}`,
    keys: {
      p256dh: Buffer.concat([Buffer.from([4]), randomBytes(64)]).toString('base64url'),
      auth: randomBytes(16).toString('base64url'),
    },
  };
}

function addSubscription(db, user) {
  const sub = fakeSubscription();
  db.prepare(
    `INSERT INTO push_subscriptions (id, user_id, endpoint, p256dh, auth, created_at, failures)
     VALUES (?, ?, ?, ?, ?, ?, 0)`,
  ).run(newId(), user.id, sub.endpoint, sub.keys.p256dh, sub.keys.auth, Date.now());
  return sub;
}

function recordingSender() {
  const calls = [];
  const sender = async (subscription, body, options) => {
    calls.push({ endpoint: subscription.endpoint, payload: JSON.parse(body), options });
    return { statusCode: 201 };
  };
  return { calls, sender };
}

async function waitFor(predicate, ms = 2000) {
  const until = Date.now() + ms;
  while (!predicate()) {
    if (Date.now() > until) throw new Error('Timed out waiting');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 50));

function multipartBody(parts) {
  const boundary = `----gma${randomBytes(8).toString('hex')}`;
  const chunks = [];
  for (const part of parts) {
    let head = `--${boundary}\r\nContent-Disposition: form-data; name="${part.name}"`;
    if (part.filename) head += `; filename="${part.filename}"\r\nContent-Type: ${part.type}`;
    chunks.push(Buffer.from(`${head}\r\n\r\n`), Buffer.isBuffer(part.value) ? part.value : Buffer.from(part.value), Buffer.from('\r\n'));
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`));
  return { payload: Buffer.concat(chunks), contentType: `multipart/form-data; boundary=${boundary}` };
}

const vapid = webpush.generateVAPIDKeys();
const PUSH_ENV = {
  VAPID_PUBLIC_KEY: vapid.publicKey,
  VAPID_PRIVATE_KEY: vapid.privateKey,
  VAPID_SUBJECT: 'mailto:ben@example.com',
};

// ---------------------------------------------------------------------------

describe('GET /grandma pairing', () => {
  let t;
  before(async () => {
    t = await makeTestApp();
  });
  after(() => t.cleanup());

  test('a valid token sets a device session and redirects without the token', async () => {
    const device = makeDevice(t.db);
    const res = await t.app.inject({ method: 'GET', url: `/grandma?device=${device.token}` });
    assert.equal(res.statusCode, 302);
    assert.equal(res.headers.location, '/grandma/');
    assert.equal(res.headers['cache-control'], 'no-store');
    const cookie = res.cookies.find((c) => c.name === 'gma_session');
    assert.ok(cookie, 'sets the session cookie');
    assert.equal(cookie.httpOnly, true);

    const state = await t.app.inject({
      method: 'GET',
      url: '/api/frame/state',
      headers: { cookie: `gma_session=${cookie.value}` },
    });
    assert.equal(state.statusCode, 200);
    assert.ok(t.db.prepare('SELECT last_seen_at FROM devices WHERE id = ?').get(device.id).last_seen_at);
  });

  test('re-opening the link at boot keeps the existing session', async () => {
    const device = makeDevice(t.db);
    const first = await t.app.inject({ method: 'GET', url: `/grandma?device=${device.token}` });
    const cookie = first.cookies.find((c) => c.name === 'gma_session');
    const again = await t.app.inject({
      method: 'GET',
      url: `/grandma?device=${device.token}`,
      headers: { cookie: `gma_session=${cookie.value}` },
    });
    assert.equal(again.statusCode, 302);
    assert.equal(again.cookies.find((c) => c.name === 'gma_session'), undefined);
    const n = t.db.prepare('SELECT COUNT(*) AS n FROM sessions WHERE device_id = ?').get(device.id).n;
    assert.equal(n, 1);
  });

  test('an unknown or revoked token gets the calm page and no session', async () => {
    const revoked = makeDevice(t.db, { revoked_at: Date.now() });
    for (const token of ['not-a-real-token-at-all-xxxxxxxx', revoked.token, '']) {
      const res = await t.app.inject({ method: 'GET', url: `/grandma?device=${encodeURIComponent(token)}` });
      assert.equal(res.statusCode, 403);
      assert.match(res.headers['content-type'], /^text\/html/);
      assert.match(res.body, /This frame isn.t set up yet\./);
      assert.match(res.body, /Ben can fix this\./);
      assert.doesNotMatch(res.body, /style=/, 'no inline style (CSP)');
      assert.equal(res.cookies.length, 0);
    }
  });

  test('without the parameter it goes to the frame', async () => {
    const res = await t.app.inject({ method: 'GET', url: '/grandma' });
    assert.equal(res.statusCode, 302);
    assert.equal(res.headers.location, '/grandma/');
  });
});

describe('frame device auth', () => {
  let t;
  before(async () => {
    t = await makeTestApp();
  });
  after(() => t.cleanup());

  test('every frame route needs a live device session', async () => {
    const user = makeUser(t.db, { role: 'admin' });
    const revoked = makeDevice(t.db);
    const revokedCookie = loginAsDevice(t.app, t.db, revoked);
    t.db.prepare('UPDATE devices SET revoked_at = ? WHERE id = ?').run(Date.now(), revoked.id);
    const routes = [
      ['GET', '/api/frame/state'],
      ['POST', '/api/frame/seen'],
      ['POST', '/api/frame/react'],
      ['POST', '/api/frame/preset'],
      ['POST', '/api/frame/voice'],
      ['POST', '/api/frame/heartbeat'],
    ];
    for (const cookie of [null, loginAs(t.app, t.db, user), revokedCookie]) {
      for (const [method, url] of routes) {
        const res = await t.app.inject({ method, url, headers: sameOrigin(cookie), payload: method === 'POST' ? {} : undefined });
        assert.equal(res.statusCode, 401, `${method} ${url}`);
        assert.equal(res.json().error.code, 'unauthorized');
      }
    }
  });
});

describe('GET /api/frame/state', () => {
  let t;
  let device;
  let cookie;
  let mike;
  let sarah;
  before(async () => {
    t = await makeTestApp();
    device = makeDevice(t.db);
    cookie = loginAsDevice(t.app, t.db, device);
    mike = makeUser(t.db, { name: 'Mike' });
    sarah = makeUser(t.db, { name: 'Sarah' });
  });
  after(() => t.cleanup());

  const getState = async () => {
    const res = await t.app.inject({ method: 'GET', url: '/api/frame/state', headers: { cookie } });
    assert.equal(res.statusCode, 200);
    assert.equal(res.headers['cache-control'], 'no-store');
    return res.json();
  };

  test('slideshow, cards, presets, settings and the family photo', async () => {
    const base = Date.now() - 50 * MINUTE;
    const old = makeItem(t.db, sarah, { created_at: base - 30 * 24 * 60 * MINUTE, caption: 'Last month' });
    const batch = newId();
    const m1 = makeItem(t.db, mike, { batch_id: batch, created_at: base, height: 2000, width: 1500 });
    const m2 = makeItem(t.db, mike, { batch_id: batch, created_at: base + 1000 });
    const m3 = makeItem(t.db, mike, { batch_id: batch, created_at: base + 2000, caption: 'Lily at the farm' });
    const video = makeItem(t.db, sarah, { kind: 'video', created_at: base + 5 * MINUTE, duration_ms: 12_000 });
    const later = makeItem(t.db, mike, { created_at: base + 40 * MINUTE });
    makeItem(t.db, mike, { status: 'processing', ready_at: null, created_at: base + 41 * MINUTE });
    makeItem(t.db, mike, { status: 'hidden', created_at: base + 42 * MINUTE });
    setSetting(t.db, 'night_start', '22:00');

    const state = await getState();
    assert.equal(typeof state.now, 'number');
    assert.equal(typeof state.night, 'boolean');
    assert.deepEqual(state.settings, {
      night_start: '22:00',
      night_end: '07:00',
      timezone: 'America/Chicago',
      max_voice_seconds: 60,
    });
    assert.equal(state.presets.length, 8);
    assert.deepEqual(state.presets[1], { id: PRESET_CALL_ME, text: 'Call me', sort: 2 });

    // Ready photos and video posters, newest first; nothing processing or hidden.
    assert.deepEqual(
      state.slideshow.map((i) => i.id),
      [later.id, video.id, m3.id, m2.id, m1.id, old.id],
    );
    const first = state.slideshow.find((i) => i.id === m3.id);
    assert.deepEqual(first.sender, { id: mike.id, name: 'Mike' });
    assert.equal(first.caption, 'Lily at the farm');
    assert.equal(first.renditions.display.url, `/media/${m3.id}/display?v=${m3.ready_at}`);
    assert.equal(first.renditions.display.width, 1600);
    const vid = state.slideshow.find((i) => i.id === video.id);
    assert.equal(vid.kind, 'video');
    assert.ok(vid.renditions.poster && vid.renditions.video);
    assert.equal(vid.duration_ms, 12_000);

    // "New for you": the batch, the video and the later photo; last month's isn't new.
    assert.deepEqual(
      state.new.map((c) => [c.title, c.items.map((i) => i.id)]),
      [
        ['Photo from Mike', [later.id]],
        ['Video from Sarah', [video.id]],
        ['3 photos from Mike', [m1.id, m2.id, m3.id]],
      ],
    );
    assert.equal(state.new[2].batch_id, batch);
    assert.ok(state.new[2].items.every((i) => i.batch_id === batch));

    // The newest landscape photo is behind the voice button.
    assert.equal(state.family_photo.item_id, later.id);
    assert.equal(state.family_photo.url, `/media/${later.id}/display?v=${later.ready_at}`);

    // Ben can choose it.
    setSetting(t.db, 'family_photo_item_id', m1.id);
    assert.equal((await getState()).family_photo.item_id, m1.id);
  });

  test('POST /api/frame/seen takes items out of "New for you"', async () => {
    const before = await getState();
    const ids = before.new.flatMap((c) => c.items.map((i) => i.id));
    assert.ok(ids.length > 0);
    const res = await t.app.inject({
      method: 'POST',
      url: '/api/frame/seen',
      headers: sameOrigin(cookie),
      payload: { item_ids: [...ids, ids[0], newId()] },
    });
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.json(), { ok: true, seen: ids.length });
    assert.deepEqual((await getState()).new, []);

    // Another frame still sees them as new.
    const other = loginAsDevice(t.app, t.db, makeDevice(t.db));
    const theirs = await t.app.inject({ method: 'GET', url: '/api/frame/state', headers: { cookie: other } });
    assert.equal(theirs.json().new.flatMap((c) => c.items).length, ids.length);
  });

  test('seen rejects a malformed list', async () => {
    for (const payload of [{}, { item_ids: 'x' }, { item_ids: ['../etc'] }]) {
      const res = await t.app.inject({ method: 'POST', url: '/api/frame/seen', headers: sameOrigin(cookie), payload });
      assert.equal(res.statusCode, 400);
      assert.equal(res.json().error.code, 'bad_item_ids');
    }
  });
});

describe('groupIntoCards', () => {
  const mike = { id: 'U1', name: 'Mike' };
  const sarah = { id: 'U2', name: 'Sarah' };
  const item = (id, sender, created_at, extra = {}) => ({ id, sender, created_at, kind: 'photo', batch_id: null, ...extra });

  test('the same sender within 10 minutes is one card; a gap starts a new one', () => {
    const cards = groupIntoCards([
      item('A', mike, 0),
      item('B', mike, 9 * MINUTE),
      item('C', mike, 18 * MINUTE),
      item('D', mike, 40 * MINUTE),
      item('E', sarah, 1 * MINUTE),
    ]);
    assert.deepEqual(
      cards.map((c) => [c.title, c.items.map((i) => i.id)]),
      [
        ['Photo from Mike', ['D']],
        ['3 photos from Mike', ['A', 'B', 'C']],
        ['Photo from Sarah', ['E']],
      ],
    );
    assert.equal(cards[1].id, 'A');
  });

  test('one batch stays one card however long it took, and is scoped to its sender', () => {
    const cards = groupIntoCards([
      item('A', mike, 0, { batch_id: 'b1' }),
      item('B', mike, 30 * MINUTE, { batch_id: 'b1', kind: 'video' }),
      item('C', sarah, 31 * MINUTE, { batch_id: 'b1' }),
    ]);
    assert.deepEqual(
      cards.map((c) => [c.title, c.count]),
      [
        ['Photo from Sarah', 1],
        ['A photo and a video from Mike', 2],
      ],
    );
  });

  test('titles', () => {
    const titles = (items) => groupIntoCards(items)[0].title;
    assert.equal(titles([item('A', sarah, 0, { kind: 'video' })]), 'Video from Sarah');
    assert.equal(titles([item('A', sarah, 0, { kind: 'video' }), item('B', sarah, 1, { kind: 'video' })]), '2 videos from Sarah');
    assert.equal(
      titles([item('A', mike, 0), item('B', mike, 1), item('C', mike, 2, { kind: 'video' }), item('D', mike, 3, { kind: 'video' })]),
      '2 photos and 2 videos from Mike',
    );
  });
});

describe('POST /api/frame/react and /api/frame/preset', () => {
  let t;
  let device;
  let cookie;
  let owner;
  let cousin;
  let ownerSub;
  const push = recordingSender();

  before(async () => {
    t = await makeTestApp({ env: PUSH_ENV, routeOptions: { pushSender: push.sender } });
    device = makeDevice(t.db);
    cookie = loginAsDevice(t.app, t.db, device);
    owner = makeUser(t.db, { name: 'Sarah' });
    cousin = makeUser(t.db, { name: 'Mike' });
    ownerSub = addSubscription(t.db, owner);
    addSubscription(t.db, cousin);
  });
  after(() => t.cleanup());
  beforeEach(() => {
    push.calls.length = 0;
  });

  const post = (url, payload) => t.app.inject({ method: 'POST', url, headers: sameOrigin(cookie), payload });

  test('a reaction is stored, published, and pushed only to the photo’s owner', async () => {
    const item = makeItem(t.db, owner, { caption: 'Lily at the farm with the goats and the big red barn' });
    const res = await post('/api/frame/react', { item_id: item.id, reaction: 'love', client_id: 'react-0001' });
    assert.equal(res.statusCode, 201);
    const { event, duplicate } = res.json();
    assert.equal(duplicate, false);
    assert.equal(event.kind, 'reaction');
    assert.equal(event.reaction, 'love');
    assert.equal(event.item.id, item.id);
    assert.deepEqual(event.recipient, { id: owner.id, name: 'Sarah' });

    const row = t.db.prepare('SELECT * FROM grandma_events WHERE id = ?').get(event.id);
    assert.equal(row.device_id, device.id);
    assert.equal(row.recipient_user_id, owner.id);
    assert.equal(row.client_id, 'react-0001');

    const published = t.db.prepare("SELECT * FROM events WHERE topic = 'grandma.event'").all();
    assert.equal(published.length, 1);
    assert.equal(published[0].audience, 'all');
    assert.equal(JSON.parse(published[0].payload).event.id, event.id);

    // Answering a photo marks it seen.
    assert.ok(t.db.prepare('SELECT 1 FROM item_views WHERE device_id = ? AND item_id = ?').get(device.id, item.id));

    await waitFor(() => push.calls.length === 1);
    await settle();
    assert.equal(push.calls.length, 1);
    assert.equal(push.calls[0].endpoint, ownerSub.endpoint);
    assert.deepEqual(push.calls[0].payload, {
      web_push: 8030,
      notification: {
        title: 'Grandma loved your photo',
        body: '❤️ Love · “Lily at the farm with the goats and the…”',
        navigate: `http://localhost:8080/from-grandma#e-${event.id}`,
        tag: `grandma-${item.id}`,
      },
    });
    assert.equal(push.calls[0].options.TTL, 2 * 24 * 60 * 60);
    assert.equal(push.calls[0].options.urgency, 'normal');
  });

  test('a repeated client_id returns the original event and never pushes again', async () => {
    const item = makeItem(t.db, owner);
    const payload = { item_id: item.id, reaction: 'wow', client_id: 'react-0002' };
    const first = await post('/api/frame/react', payload);
    assert.equal(first.statusCode, 201);
    await waitFor(() => push.calls.length === 1);

    // Even after the photo was hidden, the repeat gets the original answer.
    t.db.prepare("UPDATE items SET status = 'hidden' WHERE id = ?").run(item.id);
    const again = await post('/api/frame/react', payload);
    assert.equal(again.statusCode, 200);
    assert.equal(again.json().duplicate, true);
    assert.equal(again.json().event.id, first.json().event.id);
    await settle();
    assert.equal(push.calls.length, 1);
    assert.equal(t.db.prepare("SELECT COUNT(*) AS n FROM grandma_events WHERE client_id = 'react-0002'").get().n, 1);
    assert.equal(
      t.db.prepare("SELECT COUNT(*) AS n FROM events WHERE topic = 'grandma.event' AND payload LIKE ?").get(`%${first.json().event.id}%`).n,
      1,
    );
  });

  test('a client_id from another frame is a conflict', async () => {
    const item = makeItem(t.db, owner);
    await post('/api/frame/react', { item_id: item.id, reaction: 'love', client_id: 'react-shared' });
    const other = loginAsDevice(t.app, t.db, makeDevice(t.db));
    const res = await t.app.inject({
      method: 'POST',
      url: '/api/frame/react',
      headers: sameOrigin(other),
      payload: { item_id: item.id, reaction: 'love', client_id: 'react-shared' },
    });
    assert.equal(res.statusCode, 409);
  });

  test('bad reactions, missing ids and gone photos are refused', async () => {
    const item = makeItem(t.db, owner);
    const hidden = makeItem(t.db, owner, { status: 'hidden' });
    const cases = [
      [{ item_id: item.id, reaction: 'angry', client_id: 'react-0003' }, 400, 'bad_reaction'],
      [{ item_id: item.id, reaction: 'toString', client_id: 'react-0004' }, 400, 'bad_reaction'],
      [{ item_id: item.id, reaction: 'love' }, 400, 'bad_client_id'],
      [{ item_id: 'nope', reaction: 'love', client_id: 'react-0005' }, 400, 'bad_item'],
      [{ item_id: hidden.id, reaction: 'love', client_id: 'react-0006' }, 404, 'item_gone'],
      [{ item_id: newId(), reaction: 'love', client_id: 'react-0007' }, 404, 'item_gone'],
    ];
    for (const [payload, status, code] of cases) {
      const res = await post('/api/frame/react', payload);
      assert.equal(res.statusCode, status, JSON.stringify(payload));
      assert.equal(res.json().error.code, code);
    }
    await settle();
    assert.equal(push.calls.length, 0);
  });

  test('a preset copies its text and pushes to the owner', async () => {
    const video = makeItem(t.db, owner, { kind: 'video' });
    const res = await post('/api/frame/preset', { item_id: video.id, preset_id: PRESET_CALL_ME, client_id: 'preset-0001' });
    assert.equal(res.statusCode, 201);
    const { event } = res.json();
    assert.equal(event.kind, 'preset');
    assert.equal(event.preset_text, 'Call me');
    assert.equal(event.recipient_user_id, owner.id);

    await waitFor(() => push.calls.length === 1);
    assert.equal(push.calls[0].endpoint, ownerSub.endpoint);
    assert.deepEqual(push.calls[0].payload.notification, {
      title: 'Grandma sent you a message',
      body: '“Call me” · about your video',
      navigate: `http://localhost:8080/from-grandma#e-${event.id}`,
      tag: `grandma-${video.id}`,
    });

    const again = await post('/api/frame/preset', { item_id: video.id, preset_id: PRESET_CALL_ME, client_id: 'preset-0001' });
    assert.equal(again.statusCode, 200);
    assert.equal(again.json().event.id, event.id);
    await settle();
    assert.equal(push.calls.length, 1);
  });

  test('an unknown preset is refused', async () => {
    const item = makeItem(t.db, owner);
    const res = await post('/api/frame/preset', { item_id: item.id, preset_id: newId(), client_id: 'preset-0002' });
    assert.equal(res.statusCode, 404);
    assert.equal(res.json().error.code, 'preset_gone');
  });

  test('a state-changing request from another origin is refused', async () => {
    const item = makeItem(t.db, owner);
    const res = await t.app.inject({
      method: 'POST',
      url: '/api/frame/react',
      headers: { cookie, origin: 'https://evil.example' },
      payload: { item_id: item.id, reaction: 'love', client_id: 'react-evil1' },
    });
    assert.equal(res.statusCode, 403);
  });
});

describe('POST /api/frame/voice', () => {
  let t;
  let device;
  let cookie;
  before(async () => {
    t = await makeTestApp();
    device = makeDevice(t.db);
    cookie = loginAsDevice(t.app, t.db, device);
  });
  after(() => t.cleanup());

  const upload = (parts, cookieValue = cookie) => {
    const { payload, contentType } = multipartBody(parts);
    return t.app.inject({
      method: 'POST',
      url: '/api/frame/voice',
      headers: sameOrigin(cookieValue, { 'content-type': contentType }),
      payload,
    });
  };
  const audioPart = (bytes = Buffer.from('OggS fake opus'), type = 'audio/webm;codecs=opus') => ({
    name: 'audio',
    filename: 'voice.webm',
    type,
    value: bytes,
  });

  test('stores the recording, a processing voice note and a voice job', async () => {
    const res = await upload([{ name: 'client_id', value: 'voice-0001' }, audioPart()]);
    assert.equal(res.statusCode, 202);
    const { voice_note: note, duplicate } = res.json();
    assert.equal(duplicate, false);
    assert.equal(note.status, 'processing');

    const row = t.db.prepare('SELECT * FROM voice_notes WHERE id = ?').get(note.id);
    assert.equal(row.device_id, device.id);
    assert.equal(row.user_id, null);
    assert.equal(row.client_id, 'voice-0001');
    assert.match(row.original_path, new RegExp(`^originals/\\d{4}/\\d{2}/${note.id}\\.webm$`));
    assert.equal(fs.readFileSync(t.app.storage.resolve(row.original_path), 'utf8'), 'OggS fake opus');

    const jobs = t.db.prepare('SELECT * FROM jobs WHERE ref_id = ?').all(note.id);
    assert.equal(jobs.length, 1);
    assert.equal(jobs[0].kind, 'voice');
    assert.equal(jobs[0].status, 'queued');
    assert.equal(jobs[0].max_attempts, 3);

    // The voice job, not the upload, creates the Grandma's Feed event.
    assert.equal(t.db.prepare("SELECT COUNT(*) AS n FROM grandma_events WHERE kind = 'voice'").get().n, 0);
  });

  test('a repeat with the same client_id returns the original note, with no second job', async () => {
    // the file part first this time: field order doesn't matter
    const first = await upload([audioPart(), { name: 'client_id', value: 'voice-0002' }]);
    assert.equal(first.statusCode, 202);
    const again = await upload([{ name: 'client_id', value: 'voice-0002' }, audioPart()]);
    assert.equal(again.statusCode, 200);
    assert.equal(again.json().duplicate, true);
    assert.equal(again.json().voice_note.id, first.json().voice_note.id);
    assert.equal(t.db.prepare("SELECT COUNT(*) AS n FROM voice_notes WHERE client_id = 'voice-0002'").get().n, 1);
    assert.equal(t.db.prepare('SELECT COUNT(*) AS n FROM jobs WHERE ref_id = ?').get(first.json().voice_note.id).n, 1);
  });

  test('over 5 MB is refused kindly', async () => {
    const res = await upload([{ name: 'client_id', value: 'voice-big1' }, audioPart(Buffer.alloc(5 * 1024 * 1024 + 1))]);
    assert.equal(res.statusCode, 413);
    assert.equal(res.json().error.code, 'too_large');
    assert.equal(t.db.prepare("SELECT COUNT(*) AS n FROM voice_notes WHERE client_id = 'voice-big1'").get().n, 0);
  });

  test('missing audio, an empty file, a wrong type or a missing client_id are refused', async () => {
    const cases = [
      [[{ name: 'client_id', value: 'voice-0003' }], 400, 'no_audio'],
      [[{ name: 'client_id', value: 'voice-0004' }, audioPart(Buffer.alloc(0))], 400, 'no_audio'],
      [[{ name: 'client_id', value: 'voice-0005' }, audioPart(Buffer.from('<svg/>'), 'image/svg+xml')], 415, 'bad_audio_type'],
      [[audioPart()], 400, 'bad_client_id'],
    ];
    for (const [parts, status, code] of cases) {
      const res = await upload(parts);
      assert.equal(res.statusCode, status, code);
      assert.equal(res.json().error.code, code);
    }
    const json = await t.app.inject({
      method: 'POST',
      url: '/api/frame/voice',
      headers: sameOrigin(cookie),
      payload: { client_id: 'voice-0006' },
    });
    assert.equal(json.statusCode, 415);
  });
});

describe('POST /api/frame/heartbeat', () => {
  let t;
  before(async () => {
    t = await makeTestApp();
  });
  after(() => t.cleanup());

  test('updates the frame’s last_seen_at', async () => {
    const device = makeDevice(t.db, { last_seen_at: 1 });
    const cookie = loginAsDevice(t.app, t.db, device);
    const res = await t.app.inject({
      method: 'POST',
      url: '/api/frame/heartbeat',
      headers: sameOrigin(cookie),
      payload: { version: '2026.10.22-1', online_since: Date.now() - 1000 },
    });
    assert.equal(res.statusCode, 200);
    assert.equal(res.json().ok, true);
    assert.ok(t.db.prepare('SELECT last_seen_at FROM devices WHERE id = ?').get(device.id).last_seen_at > 1);

    const bad = await t.app.inject({
      method: 'POST',
      url: '/api/frame/heartbeat',
      headers: sameOrigin(cookie),
      payload: { version: 42 },
    });
    assert.equal(bad.statusCode, 400);
  });
});
