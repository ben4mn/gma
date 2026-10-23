// Grandma's Feed: GET /api/grandma-events. Shared with the whole family; each
// event carries the photo it was about, who sent that photo and who it went to.

import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { newId } from '../src/lib/ids.js';
import { loginAs, loginAsDevice, makeDevice, makeTestApp, makeUser, sameOrigin } from './helpers/index.js';

const PRESET_MISS_YOU = '01M5GEGM00FFBC4TAMAWYG9Q1Y';

function makeItem(db, user, overrides = {}) {
  const at = Date.now();
  const item = { id: newId(at), kind: 'photo', caption: null, status: 'ready', ready_at: at + 1, ...overrides };
  db.prepare(
    `INSERT INTO items (id, user_id, kind, caption, status, created_at, ready_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(item.id, user.id, item.kind, item.caption, item.status, at, item.ready_at);
  const names = item.kind === 'photo' ? ['thumb', 'display'] : ['thumb', 'poster', 'video'];
  for (const name of names) {
    db.prepare('INSERT INTO renditions (item_id, name, path, mime, width, height) VALUES (?, ?, ?, ?, ?, ?)').run(
      item.id,
      name,
      `renditions/${item.id}/${name}.webp`,
      'image/webp',
      480,
      360,
    );
  }
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

function makeVoiceNote(db, device, { status = 'ready', durationMs = 42_000 } = {}) {
  const id = newId();
  db.prepare(
    `INSERT INTO voice_notes (id, device_id, status, duration_ms, audio_path, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(id, device.id, status, durationMs, status === 'ready' ? `renditions/${id}/audio.m4a` : null, Date.now());
  return id;
}

describe('GET /api/grandma-events', () => {
  let t;
  let device;
  let sarah;
  let mike;
  let cookie;
  const ids = {};

  before(async () => {
    t = await makeTestApp();
    device = makeDevice(t.db);
    sarah = makeUser(t.db, { name: 'Sarah Lee' });
    mike = makeUser(t.db, { name: 'Mike' });
    cookie = loginAs(t.app, t.db, mike);

    const farm = makeItem(t.db, sarah, { caption: 'Lily at the farm' });
    const video = makeItem(t.db, mike, { kind: 'video' });
    const hidden = makeItem(t.db, sarah, { caption: 'Hidden by Ben', status: 'hidden' });
    ids.farm = farm;
    ids.video = video;
    ids.reaction = makeEvent(t.db, device, { kind: 'reaction', item_id: farm.id, reaction: 'love', recipient_user_id: sarah.id });
    ids.preset = makeEvent(t.db, device, {
      kind: 'preset',
      item_id: video.id,
      preset_id: PRESET_MISS_YOU,
      preset_text: 'Miss you all',
      recipient_user_id: mike.id,
    });
    ids.hidden = makeEvent(t.db, device, { kind: 'reaction', item_id: hidden.id, reaction: 'wow', recipient_user_id: sarah.id });
    ids.voiceProcessing = makeEvent(t.db, device, { kind: 'voice', voice_note_id: makeVoiceNote(t.db, device, { status: 'processing' }) });
    ids.voiceNoteId = makeVoiceNote(t.db, device);
    ids.voice = makeEvent(t.db, device, { kind: 'voice', voice_note_id: ids.voiceNoteId });
  });
  after(() => t.cleanup());

  const get = async (query = '') => {
    const res = await t.app.inject({ method: 'GET', url: `/api/grandma-events${query}`, headers: { cookie } });
    assert.equal(res.statusCode, 200, res.body);
    return res.json();
  };

  test('needs a family member; a frame or a stranger gets 401', async () => {
    const frame = loginAsDevice(t.app, t.db, makeDevice(t.db));
    for (const c of [null, frame]) {
      const res = await t.app.inject({ method: 'GET', url: '/api/grandma-events', headers: sameOrigin(c) });
      assert.equal(res.statusCode, 401);
    }
  });

  test('every event, newest first, in the feed’s shape', async () => {
    const { events, next_before: next } = await get();
    assert.equal(next, null);
    assert.deepEqual(
      events.map((e) => e.id),
      [ids.voice, ids.voiceProcessing, ids.hidden, ids.preset, ids.reaction],
    );

    const reaction = events.find((e) => e.id === ids.reaction);
    assert.equal(reaction.kind, 'reaction');
    assert.equal(reaction.reaction, 'love');
    assert.equal(typeof reaction.created_at, 'number');
    assert.equal(reaction.thumb_url, `/media/${ids.farm.id}/thumb?v=${ids.farm.ready_at}`);
    assert.deepEqual(reaction.sender, { id: sarah.id, name: 'Sarah Lee' });
    assert.deepEqual(reaction.item, {
      id: ids.farm.id,
      kind: 'photo',
      caption: 'Lily at the farm',
      ready_at: ids.farm.ready_at,
      available: true,
      thumb_url: `/media/${ids.farm.id}/thumb?v=${ids.farm.ready_at}`,
      user: { id: sarah.id, name: 'Sarah Lee' },
    });
    // Mike sees Grandma's reaction to Sarah's photo too: the feed is shared.
    assert.deepEqual(reaction.recipient, { id: sarah.id, name: 'Sarah Lee' });
    assert.equal(reaction.recipient_name, 'Sarah Lee');
    assert.equal(reaction.voice_note, null);

    const preset = events.find((e) => e.id === ids.preset);
    assert.equal(preset.preset_text, 'Miss you all');
    assert.equal(preset.item.kind, 'video');
    assert.equal(preset.recipient_name, 'Mike');

    const voice = events.find((e) => e.id === ids.voice);
    assert.equal(voice.item, null);
    assert.equal(voice.recipient, null);
    assert.equal(voice.recipient_name, 'everyone');
    assert.deepEqual(voice.voice_note, {
      id: ids.voiceNoteId,
      status: 'ready',
      duration_ms: 42_000,
      url: `/media/voice/${ids.voiceNoteId}`,
    });

    // No audio URL until the voice job has made the m4a.
    const processing = events.find((e) => e.id === ids.voiceProcessing);
    assert.equal(processing.voice_note.status, 'processing');
    assert.equal(processing.voice_note.url, null);
  });

  test('a hidden photo keeps its place but shows no picture or caption', async () => {
    const { events } = await get();
    const hidden = events.find((e) => e.id === ids.hidden);
    assert.equal(hidden.item.available, false);
    assert.equal(hidden.item.caption, null);
    assert.equal(hidden.item.thumb_url, null);
    assert.equal(hidden.thumb_url, null);
    assert.equal(hidden.reaction, 'wow');
  });

  test('a deleted photo leaves the event with no item', async () => {
    const gone = makeItem(t.db, sarah);
    const eventId = makeEvent(t.db, device, { kind: 'reaction', item_id: gone.id, reaction: 'funny', recipient_user_id: sarah.id });
    t.db.prepare('DELETE FROM items WHERE id = ?').run(gone.id);
    const { events } = await get();
    const event = events.find((e) => e.id === eventId);
    assert.equal(event.item, null);
    assert.equal(event.thumb_url, null);
    assert.equal(event.recipient_name, 'Sarah Lee');
    t.db.prepare('DELETE FROM grandma_events WHERE id = ?').run(eventId);
  });

  test('pages with ?before= and ?limit=', async () => {
    const page1 = await get('?limit=2');
    assert.deepEqual(page1.events.map((e) => e.id), [ids.voice, ids.voiceProcessing]);
    assert.equal(page1.next_before, ids.voiceProcessing);
    const page2 = await get(`?limit=2&before=${page1.next_before}`);
    assert.deepEqual(page2.events.map((e) => e.id), [ids.hidden, ids.preset]);
    const page3 = await get(`?limit=2&before=${page2.next_before}`);
    assert.deepEqual(page3.events.map((e) => e.id), [ids.reaction]);
    assert.equal(page3.next_before, null);
  });

  test('a malformed cursor or limit is a readable 400', async () => {
    for (const query of ['?before=nope', '?limit=0', '?limit=abc']) {
      const res = await t.app.inject({ method: 'GET', url: `/api/grandma-events${query}`, headers: { cookie } });
      assert.equal(res.statusCode, 400, query);
      assert.match(res.json().error.message, /\.$/);
    }
    // An oversized limit is clamped rather than refused.
    assert.equal((await get('?limit=5000')).events.length, 5);
  });
});
