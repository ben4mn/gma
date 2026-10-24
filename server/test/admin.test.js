import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { after, before, describe, test } from 'node:test';
import { newId } from '../src/lib/ids.js';
import { loadSession } from '../src/lib/sessions.js';
import { getSetting, setSetting } from '../src/lib/settings.js';
import { sha256 } from '../src/lib/tokens.js';
import { loginAs, loginAsDevice, makeDevice, makeTestApp, makeUser, sameOrigin } from './helpers/index.js';

function eventsFor(db, topic) {
  return db
    .prepare('SELECT * FROM events WHERE topic = ? ORDER BY id')
    .all(topic)
    .map((row) => ({ ...row, payload: JSON.parse(row.payload) }));
}

function adminLog(db, action) {
  return db.prepare('SELECT * FROM admin_log WHERE action = ? ORDER BY created_at').all(action);
}

// An item with an original and two renditions on disk.
async function makeItem(t, owner, overrides = {}) {
  const id = newId();
  const now = Date.now();
  const originalPath = t.app.storage.originalKey(id, 'jpg', now);
  await fs.writeFile(await t.app.storage.ensureDirFor(originalPath), 'original');
  const item = {
    id,
    user_id: owner.id,
    kind: 'photo',
    caption: 'Lily at the farm',
    status: 'ready',
    original_path: originalPath,
    original_mime: 'image/jpeg',
    original_bytes: 8,
    created_at: now,
    ready_at: now,
    ...overrides,
  };
  t.db
    .prepare(
      `INSERT INTO items (id, user_id, kind, caption, status, original_path, original_mime, original_bytes, created_at, ready_at)
       VALUES (@id, @user_id, @kind, @caption, @status, @original_path, @original_mime, @original_bytes, @created_at, @ready_at)`,
    )
    .run(item);
  for (const [name, ext, mime] of [
    ['thumb', 'webp', 'image/webp'],
    ['display', 'jpg', 'image/jpeg'],
  ]) {
    const key = t.app.storage.renditionKey(id, name, ext);
    await fs.writeFile(await t.app.storage.ensureDirFor(key), name);
    t.db
      .prepare('INSERT INTO renditions (item_id, name, path, mime, width, height, bytes) VALUES (?, ?, ?, ?, 480, 320, 5)')
      .run(id, name, key, mime);
  }
  return item;
}

async function exists(file) {
  return fs.access(file).then(
    () => true,
    () => false,
  );
}

describe('admin API', () => {
  let t;
  let admin;
  let cookie;

  before(async () => {
    t = await makeTestApp();
    admin = makeUser(t.db, { name: 'Ben', role: 'admin' });
    cookie = loginAs(t.app, t.db, admin);
  });
  after(async () => t.cleanup());

  const get = (url, c = cookie) => t.app.inject({ method: 'GET', url, headers: { cookie: c } });
  const send = (method, url, payload, c = cookie) =>
    t.app.inject({ method, url, headers: sameOrigin(c), ...(payload === undefined ? {} : { payload }) });

  describe('guards', () => {
    test('signed out is 401 and a member is 403', async () => {
      const signedOut = await t.app.inject({ method: 'GET', url: '/api/admin/people' });
      assert.equal(signedOut.statusCode, 401);
      const member = makeUser(t.db);
      const res = await get('/api/admin/people', loginAs(t.app, t.db, member));
      assert.equal(res.statusCode, 403);
      assert.equal(res.json().error.code, 'forbidden');
    });

    test('a frame cannot use the admin API', async () => {
      const device = makeDevice(t.db);
      const res = await get('/api/admin/health', loginAsDevice(t.app, t.db, device));
      assert.equal(res.statusCode, 401);
    });

    test('responses are never cached', async () => {
      const res = await get('/api/admin/settings');
      assert.equal(res.headers['cache-control'], 'no-store');
    });

    test('a state change from another origin is refused', async () => {
      const res = await t.app.inject({
        method: 'POST',
        url: '/api/admin/devices',
        headers: { cookie, origin: 'https://evil.example' },
        payload: { name: 'x' },
      });
      assert.equal(res.statusCode, 403);
      assert.equal(res.json().error.code, 'bad_origin');
    });
  });

  describe('invites', () => {
    test('an emailed invite sends the link, stores only its hash and marks sent_at', async () => {
      const res = await send('POST', '/api/admin/invites', { name: 'Sarah', email: 'sarah@example.com', send: true });
      assert.equal(res.statusCode, 201);
      const body = res.json();
      assert.equal(body.sent, true);
      assert.match(body.url, /^http:\/\/localhost:8080\/join\/[\w-]{40,}$/);
      const token = body.url.split('/join/')[1];

      const row = t.db.prepare('SELECT * FROM invites WHERE id = ?').get(body.invite.id);
      assert.equal(row.token_hash, sha256(token));
      assert.ok(row.sent_at);
      assert.equal(row.role, 'member');
      assert.equal(row.created_by, admin.id);
      assert.ok(Math.abs(row.expires_at - row.created_at - 14 * 86_400_000) < 1000);
      assert.equal(body.invite.token_hash, undefined);

      const mail = t.mail.at(-1);
      assert.equal(mail.to, 'sarah@example.com');
      assert.match(mail.subject, /Ben invited you/);
      assert.ok(mail.text.includes(body.url));

      const logged = adminLog(t.db, 'invite.create').at(-1);
      assert.equal(logged.user_id, admin.id);
      assert.ok(!logged.detail.includes(token), 'the token never reaches the admin log');
    });

    test('an invite shared another way needs no email and is not sent', async () => {
      const before = t.mail.length;
      const res = await send('POST', '/api/admin/invites', { name: 'Uncle Joe', send: false });
      assert.equal(res.statusCode, 201);
      assert.equal(res.json().sent, false);
      assert.equal(res.json().invite.sent_at, null);
      assert.equal(t.mail.length, before);
    });

    test('asking to email an invite without an address is a readable 400', async () => {
      const res = await send('POST', '/api/admin/invites', { name: 'Ann', email: '', send: true });
      assert.equal(res.statusCode, 400);
      assert.equal(res.json().error.code, 'email_required');
      const noName = await send('POST', '/api/admin/invites', { email: 'a@example.com' });
      assert.equal(noName.json().error.code, 'name_required');
      const badEmail = await send('POST', '/api/admin/invites', { name: 'A', email: 'not-an-email' });
      assert.equal(badEmail.json().error.code, 'bad_email');
      const badRole = await send('POST', '/api/admin/invites', { name: 'A', role: 'owner' });
      assert.equal(badRole.json().error.code, 'bad_role');
    });

    test('inviting someone already in the family is a 409', async () => {
      const member = makeUser(t.db, { name: 'Mike', email: 'mike@example.com' });
      const res = await send('POST', '/api/admin/invites', { name: 'Mike', email: 'MIKE@example.com' });
      assert.equal(res.statusCode, 409);
      assert.match(res.json().error.message, /Mike is already in the family/);
      t.db.prepare("UPDATE users SET status = 'removed' WHERE id = ?").run(member.id);
      const removed = await send('POST', '/api/admin/invites', { name: 'Mike', email: 'mike@example.com' });
      assert.equal(removed.json().error.code, 'removed_member');
    });

    test('a new invite to the same address replaces the open one', async () => {
      const first = (await send('POST', '/api/admin/invites', { name: 'Kim', email: 'kim@example.com' })).json();
      const second = (await send('POST', '/api/admin/invites', { name: 'Kim', email: 'kim@example.com' })).json();
      const rows = t.db.prepare('SELECT id, revoked_at FROM invites WHERE email = ?').all('kim@example.com');
      assert.ok(rows.find((r) => r.id === first.invite.id).revoked_at);
      assert.equal(rows.find((r) => r.id === second.invite.id).revoked_at, null);
    });

    test('people lists everyone plus the open invites only', async () => {
      const res = await get('/api/admin/people');
      assert.equal(res.statusCode, 200);
      const { people, invites } = res.json();
      assert.ok(people.some((p) => p.id === admin.id && p.role === 'admin'));
      assert.ok(people.every((p) => 'item_count' in p && 'passkey_count' in p));
      assert.ok(invites.length > 0);
      assert.ok(invites.every((i) => !i.used_at && !i.revoked_at && i.expires_at > Date.now()));
    });

    test('cancelling an invite revokes it; a used one cannot be cancelled', async () => {
      const { invite } = (await send('POST', '/api/admin/invites', { name: 'Tess' })).json();
      const res = await send('DELETE', `/api/admin/invites/${invite.id}`);
      assert.equal(res.statusCode, 200);
      assert.ok(res.json().invite.revoked_at);
      const listed = (await get('/api/admin/people')).json().invites;
      assert.ok(!listed.some((i) => i.id === invite.id));

      const used = (await send('POST', '/api/admin/invites', { name: 'Used' })).json().invite;
      t.db.prepare('UPDATE invites SET used_at = ? WHERE id = ?').run(Date.now(), used.id);
      assert.equal((await send('DELETE', `/api/admin/invites/${used.id}`)).statusCode, 409);
      assert.equal((await send('DELETE', `/api/admin/invites/${newId()}`)).statusCode, 404);
      assert.equal((await send('DELETE', '/api/admin/invites/nope')).statusCode, 404);
    });
  });

  describe('removing and restoring people', () => {
    test('remove signs them out everywhere and deletes passkeys, push and open invites', async () => {
      const person = makeUser(t.db, { name: 'Dana', email: 'dana@example.com' });
      const theirCookie = loginAs(t.app, t.db, person);
      const token = theirCookie.split('=')[1];
      t.db
        .prepare("INSERT INTO passkeys (id, user_id, public_key, created_at) VALUES ('cred-1', ?, x'00', ?)")
        .run(person.id, Date.now());
      t.db
        .prepare(
          "INSERT INTO push_subscriptions (id, user_id, endpoint, p256dh, auth, created_at) VALUES (?, ?, 'https://push.example/1', 'k', 'a', ?)",
        )
        .run(newId(), person.id, Date.now());
      t.db
        .prepare(
          "INSERT INTO invites (id, token_hash, email, expires_at, created_at) VALUES (?, 'h-dana', 'dana@example.com', ?, ?)",
        )
        .run(newId(), Date.now() + 86_400_000, Date.now());

      const res = await send('POST', `/api/admin/people/${person.id}/remove`);
      assert.equal(res.statusCode, 200);
      assert.equal(res.json().user.status, 'removed');
      assert.equal(loadSession(t.db, token), null);
      assert.equal(t.db.prepare('SELECT COUNT(*) AS n FROM sessions WHERE user_id = ?').get(person.id).n, 0);
      assert.equal(t.db.prepare('SELECT COUNT(*) AS n FROM passkeys WHERE user_id = ?').get(person.id).n, 0);
      assert.equal(t.db.prepare('SELECT COUNT(*) AS n FROM push_subscriptions WHERE user_id = ?').get(person.id).n, 0);
      assert.ok(t.db.prepare("SELECT revoked_at FROM invites WHERE token_hash = 'h-dana'").get().revoked_at);
      assert.equal((await get('/api/admin/people', theirCookie)).statusCode, 401);
      assert.equal(JSON.parse(adminLog(t.db, 'person.remove').at(-1).detail).passkeys, 1);

      // Removing twice is harmless.
      assert.equal((await send('POST', `/api/admin/people/${person.id}/remove`)).statusCode, 200);

      const restored = await send('POST', `/api/admin/people/${person.id}/restore`);
      assert.equal(restored.json().user.status, 'active');
      assert.equal(restored.json().user.removed_at, null);
      assert.equal(adminLog(t.db, 'person.restore').length, 1);
    });

    test('someone who never signed in is restored as pending', async () => {
      const person = makeUser(t.db, { status: 'removed', activated_at: null, removed_at: Date.now() });
      const res = await send('POST', `/api/admin/people/${person.id}/restore`);
      assert.equal(res.json().user.status, 'pending');
    });

    test('an admin cannot remove themselves; unknown people are 404', async () => {
      const res = await send('POST', `/api/admin/people/${admin.id}/remove`);
      assert.equal(res.statusCode, 400);
      assert.equal(res.json().error.code, 'cannot_remove_self');
      assert.equal((await send('POST', `/api/admin/people/${newId()}/remove`)).statusCode, 404);
    });
  });

  describe('uploads', () => {
    test('lists items with their owner and rendition URLs, filtered by status', async () => {
      const owner = makeUser(t.db, { name: 'Sarah' });
      const ready = await makeItem(t, owner);
      await makeItem(t, owner, { status: 'failed', ready_at: null });
      const res = await get('/api/admin/items?status=ready');
      assert.equal(res.statusCode, 200);
      const found = res.json().items.find((i) => i.id === ready.id);
      assert.equal(found.user.name, 'Sarah');
      assert.equal(found.renditions.thumb.url, `/media/${ready.id}/thumb?v=${ready.ready_at}`);
      assert.ok(res.json().items.every((i) => i.status === 'ready'));
      assert.equal((await get('/api/admin/items?status=weird')).statusCode, 400);
      const all = (await get('/api/admin/items?limit=1')).json();
      assert.equal(all.items.length, 1);
      assert.ok(all.next_before);
    });

    test('hide and unhide publish item.removed and item.ready', async () => {
      const owner = makeUser(t.db);
      const item = await makeItem(t, owner);
      const hidden = await send('POST', `/api/admin/items/${item.id}/hide`);
      assert.equal(hidden.statusCode, 200);
      const row = t.db.prepare('SELECT status, hidden_at FROM items WHERE id = ?').get(item.id);
      assert.equal(row.status, 'hidden');
      assert.ok(row.hidden_at);
      assert.ok(eventsFor(t.db, 'item.removed').some((e) => e.payload.item_id === item.id && e.audience === 'all'));

      const shown = await send('POST', `/api/admin/items/${item.id}/unhide`);
      assert.equal(shown.statusCode, 200);
      assert.equal(t.db.prepare('SELECT status FROM items WHERE id = ?').get(item.id).status, 'ready');
      assert.ok(eventsFor(t.db, 'item.ready').some((e) => e.payload.item_id === item.id));
      assert.equal(adminLog(t.db, 'item.hide').length >= 1, true);
    });

    test('an item still processing cannot be hidden', async () => {
      const item = await makeItem(t, makeUser(t.db), { status: 'processing', ready_at: null });
      const res = await send('POST', `/api/admin/items/${item.id}/hide`);
      assert.equal(res.statusCode, 409);
      assert.equal((await send('POST', `/api/admin/items/${item.id}/unhide`)).statusCode, 409);
    });

    test('delete removes the files, the row and its jobs; Grandma’s feed keeps the event', async () => {
      const owner = makeUser(t.db);
      const item = await makeItem(t, owner);
      const device = makeDevice(t.db);
      const eventId = newId();
      t.db
        .prepare(
          "INSERT INTO grandma_events (id, device_id, kind, item_id, reaction, recipient_user_id, client_id, created_at) VALUES (?, ?, 'reaction', ?, 'love', ?, ?, ?)",
        )
        .run(eventId, device.id, item.id, owner.id, `c-${eventId}`, Date.now());
      t.db
        .prepare(
          "INSERT INTO jobs (id, kind, ref_id, status, run_after, created_at, updated_at) VALUES (?, 'image', ?, 'queued', 0, 0, 0)",
        )
        .run(newId(), item.id);
      const originalFile = t.app.storage.resolve(item.original_path);
      const renditionFile = t.app.storage.resolve(t.app.storage.renditionKey(item.id, 'thumb', 'webp'));
      assert.ok(await exists(originalFile));

      const res = await send('DELETE', `/api/admin/items/${item.id}`);
      assert.equal(res.statusCode, 200);
      assert.equal(t.db.prepare('SELECT COUNT(*) AS n FROM items WHERE id = ?').get(item.id).n, 0);
      assert.equal(t.db.prepare('SELECT COUNT(*) AS n FROM renditions WHERE item_id = ?').get(item.id).n, 0);
      assert.equal(t.db.prepare('SELECT COUNT(*) AS n FROM jobs WHERE ref_id = ?').get(item.id).n, 0);
      assert.equal(t.db.prepare('SELECT item_id FROM grandma_events WHERE id = ?').get(eventId).item_id, null);
      assert.equal(await exists(originalFile), false);
      assert.equal(await exists(renditionFile), false);
      assert.ok(eventsFor(t.db, 'item.removed').some((e) => e.payload.item_id === item.id));
      assert.equal((await send('DELETE', `/api/admin/items/${item.id}`)).statusCode, 404);
    });
  });

  describe("Grandma's frame", () => {
    test('pairing returns the link once and stores only its hash', async () => {
      const res = await send('POST', '/api/admin/devices', { name: 'Kitchen frame' });
      assert.equal(res.statusCode, 201);
      const { device, url } = res.json();
      assert.match(url, /^http:\/\/localhost:8080\/grandma\?device=[\w-]{40,}$/);
      const token = decodeURIComponent(url.split('device=')[1]);
      const row = t.db.prepare('SELECT * FROM devices WHERE id = ?').get(device.id);
      assert.equal(row.token_hash, sha256(token));
      assert.equal(row.created_by, admin.id);
      assert.equal(device.token_hash, undefined);
      const listed = (await get('/api/admin/devices')).json().devices;
      assert.ok(listed.some((d) => d.id === device.id && d.name === 'Kitchen frame' && !('token_hash' in d)));
      const logged = adminLog(t.db, 'device.pair').at(-1);
      assert.ok(!(logged.detail ?? '').includes(token));
    });

    test('a pairing with no name gets the default name', async () => {
      const res = await send('POST', '/api/admin/devices', {});
      assert.equal(res.json().device.name, "Grandma's frame");
    });

    test('reload sends frame.reload to that frame only', async () => {
      const device = makeDevice(t.db);
      const res = await send('POST', `/api/admin/devices/${device.id}/reload`);
      assert.equal(res.statusCode, 200);
      const event = eventsFor(t.db, 'frame.reload').at(-1);
      assert.equal(event.id, res.json().event_id);
      assert.equal(event.audience, `device:${device.id}`);
    });

    test('revoke unpairs the frame and ends its sessions', async () => {
      const device = makeDevice(t.db);
      const frameCookie = loginAsDevice(t.app, t.db, device);
      const res = await send('POST', `/api/admin/devices/${device.id}/revoke`);
      assert.equal(res.statusCode, 200);
      assert.ok(res.json().device.revoked_at);
      assert.equal(loadSession(t.db, frameCookie.split('=')[1]), null);
      assert.equal((await send('POST', `/api/admin/devices/${device.id}/reload`)).statusCode, 409);
      assert.equal((await send('POST', `/api/admin/devices/${newId()}/revoke`)).statusCode, 404);
    });
  });

  describe('preset messages', () => {
    test('lists the eight seeded presets in order', async () => {
      const { presets } = (await get('/api/admin/presets')).json();
      assert.equal(presets.length, 8);
      assert.equal(presets[0].text, 'Love you');
      assert.equal(presets[7].text, 'Proud of you');
    });

    test('saving reorders, renames, adds, deletes unused and turns off used presets', async () => {
      const { presets } = (await get('/api/admin/presets')).json();
      const [love, call, thanks, miss] = presets;
      const device = makeDevice(t.db);
      t.db
        .prepare(
          "INSERT INTO grandma_events (id, device_id, kind, preset_id, preset_text, client_id, created_at) VALUES (?, ?, 'preset', ?, 'Thank you', ?, ?)",
        )
        .run(newId(), device.id, thanks.id, `c-${newId()}`, Date.now());

      const res = await send('PUT', '/api/admin/presets', {
        presets: [
          { ...call, text: '  Please   call me ' },
          { id: love.id, text: 'Love you', active: 1 },
          { id: miss.id, text: 'Miss you all', active: 0 },
          { id: null, text: 'Happy birthday!' },
        ],
      });
      assert.equal(res.statusCode, 200);
      const saved = res.json().presets;
      assert.deepEqual(
        saved.slice(0, 4).map((p) => [p.text, p.active]),
        [
          ['Please call me', 1],
          ['Love you', 1],
          ['Miss you all', 0],
          ['Happy birthday!', 1],
        ],
      );
      const kept = saved.find((p) => p.id === thanks.id);
      assert.equal(kept.active, 0, 'a preset Grandma has used is turned off, not deleted');
      assert.equal(saved.length, 5, 'unused presets left out are deleted');
      assert.ok(eventsFor(t.db, 'settings.changed').some((e) => e.payload.keys.includes('presets')));
    });

    test('rejects empty, overlong, unknown and too many active presets', async () => {
      const put = (presets) => send('PUT', '/api/admin/presets', { presets });
      assert.equal((await put([])).json().error.code, 'presets_required');
      assert.equal((await put([{ text: 'x'.repeat(41) }])).json().error.code, 'preset_too_long');
      assert.equal((await put([{ text: '   ' }])).json().error.code, 'preset_empty');
      assert.equal((await put([{ id: newId(), text: 'Hi' }])).json().error.code, 'unknown_preset');
      assert.equal((await put([{ text: 'Hi', active: false }])).json().error.code, 'no_active_presets');
      const nine = Array.from({ length: 9 }, (_, i) => ({ text: `Message ${i}` }));
      const res = await put(nine);
      assert.equal(res.statusCode, 400);
      assert.equal(res.json().error.code, 'too_many_active');
    });
  });

  describe('settings', () => {
    test('reads the editable settings with defaults', async () => {
      const { settings } = (await get('/api/admin/settings')).json();
      assert.deepEqual(settings, {
        night_start: '21:00',
        night_end: '07:00',
        timezone: 'America/Chicago',
        max_video_seconds: 180,
        max_voice_seconds: 60,
      });
    });

    test('saves valid changes, publishes settings.changed and logs them', async () => {
      const res = await send('PUT', '/api/admin/settings', { night_start: '20:30', timezone: 'Europe/London' });
      assert.equal(res.statusCode, 200);
      assert.equal(res.json().settings.night_start, '20:30');
      assert.equal(getSetting(t.db, 'timezone'), 'Europe/London');
      assert.deepEqual(eventsFor(t.db, 'settings.changed').at(-1).payload.keys, ['night_start', 'timezone']);
      assert.equal(JSON.parse(adminLog(t.db, 'settings.update').at(-1).detail).night_start, '20:30');
    });

    test('rejects bad values with a readable message and saves nothing', async () => {
      const cases = [
        [{ night_end: '25:00' }, 'bad_setting'],
        [{ timezone: 'Mars/Olympus' }, 'bad_setting'],
        [{ max_video_seconds: 5 }, 'bad_setting'],
        [{ max_voice_seconds: 61 }, 'bad_setting'],
        [{ max_voice_seconds: '30' }, 'bad_setting'],
        [{ worker_last_seen: 1 }, 'unknown_setting'],
        [{}, 'nothing_to_save'],
      ];
      for (const [payload, code] of cases) {
        const res = await send('PUT', '/api/admin/settings', payload);
        assert.equal(res.statusCode, 400, JSON.stringify(payload));
        assert.equal(res.json().error.code, code);
        assert.ok(res.json().error.message.length > 10);
      }
      const mixed = await send('PUT', '/api/admin/settings', { night_start: '22:00', night_end: 'late' });
      assert.equal(mixed.statusCode, 400);
      assert.notEqual(getSetting(t.db, 'night_start'), '22:00');
    });
  });

  describe('health', () => {
    test('reports queue depth, failed jobs, disk, frames and the worker', async () => {
      const insertJob = t.db.prepare(
        'INSERT INTO jobs (id, kind, ref_id, status, error, run_after, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 0, 0, ?)',
      );
      insertJob.run(newId(), 'image', newId(), 'queued', null, 1);
      insertJob.run(newId(), 'video', newId(), 'running', null, 2);
      insertJob.run(newId(), 'video', newId(), 'failed', 'ffmpeg exited with code 1', 3);
      const seen = Date.now() - 60_000;
      makeDevice(t.db, { last_seen_at: seen });
      makeDevice(t.db, { last_seen_at: Date.now(), revoked_at: Date.now() });
      setSetting(t.db, 'worker_last_seen', 1234);

      const res = await get('/api/admin/health');
      assert.equal(res.statusCode, 200);
      const h = res.json();
      assert.ok(h.queue_depth >= 2);
      assert.ok(h.running >= 1);
      assert.ok(h.failed_jobs >= 1);
      assert.equal(h.recent_failures[0].error, 'ffmpeg exited with code 1');
      assert.ok(h.disk_free_bytes > 0);
      assert.ok(h.disk_total_bytes >= h.disk_free_bytes);
      assert.equal(h.frame_last_seen, seen, 'revoked frames are ignored');
      assert.equal(h.worker_last_seen, 1234);
      assert.equal(typeof h.items.ready, 'number');
    });
  });
});

describe('admin API: invite email failures', () => {
  test('a failed send is a readable 424 and creates no invite', async () => {
    const { buildApp } = await import('../src/app.js');
    const { makeTempDir, makeTestConfig } = await import('./helpers/index.js');
    const tempDir = await makeTempDir();
    // A config with no capture box, so sendEmail really calls (the stubbed) fetch.
    const config = makeTestConfig(tempDir, { EMAIL_TRANSPORT: 'resend', RESEND_API_KEY: 're_test' });
    const app = await buildApp(config);
    const realFetch = globalThis.fetch;
    globalThis.fetch = async () => new Response('{"message":"nope"}', { status: 500 });
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
      assert.match(res.json().error.message, /send the link yourself/);
      assert.equal(app.db.prepare('SELECT COUNT(*) AS n FROM invites').get().n, 0);
    } finally {
      globalThis.fetch = realFetch;
      await app.close();
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });
});
