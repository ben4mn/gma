import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeItem, groupIntoCards, cardTitle, cardDetail, slideshowItems, sentLine, familyPhotoUrl, shortName,
} from '../grandma/lib/cards.js';

const item = (id, extra = {}) => ({
  id, kind: 'photo', user: { id: 'u1', name: 'Mike' }, created_at: 1000, ready_at: 1000,
  renditions: { display: `/media/${id}/display?v=1`, thumb: `/media/${id}/thumb?v=1` }, ...extra,
});

test('normalizeItem reads rendition maps, {url} objects and bare names', () => {
  assert.equal(normalizeItem(item('a')).display, '/media/a/display?v=1');
  assert.equal(normalizeItem(item('b', { renditions: { display: { url: '/x.jpg', width: 3, height: 4 } } })).display, '/x.jpg');
  const bare = normalizeItem(item('c', { ready_at: 77, renditions: [{ name: 'poster' }, { name: 'video' }], kind: 'video' }));
  assert.equal(bare.poster, '/media/c/poster?v=77');
  assert.equal(bare.video, '/media/c/video?v=77');
  assert.equal(bare.display, '/media/c/poster?v=77'); // a video's display is its poster
  assert.equal(normalizeItem(item('d', { renditions: { display: { url: '/d.jpg', width: 300, height: 400 } } })).height, 400);
});

test('normalizeItem finds the sender in any of its usual places', () => {
  assert.equal(normalizeItem(item('a')).senderName, 'Mike');
  assert.equal(normalizeItem({ id: 'b', sender: { name: 'Sarah' } }).senderName, 'Sarah');
  assert.equal(normalizeItem({ id: 'c', user_name: 'Lily' }).senderName, 'Lily');
  assert.equal(normalizeItem({ id: 'd' }).senderName, 'Your family');
  assert.equal(normalizeItem(null), null);
});

test('Grandma sees short names: the one Ben chose, else the first word of the name', () => {
  assert.equal(normalizeItem(item('a', { user: { id: 'u1', name: 'Mike Lee', short_name: 'Mikey' } })).senderName, 'Mikey');
  assert.equal(normalizeItem(item('b', { user: { id: 'u1', name: 'Mike Lee' } })).senderName, 'Mike');
  assert.equal(normalizeItem(item('c', { user: { id: 'u1', name: 'Joe Lee', short_name: '  Grandpa   Joe ' } })).senderName, 'Grandpa Joe');
  assert.equal(normalizeItem(item('d', { user: { id: 'u1', name: 'Mike Lee', short_name: '   ' } })).senderName, 'Mike');
  assert.equal(normalizeItem({ id: 'e', user_name: 'Lily Lee', user_short_name: 'Lil' }).senderName, 'Lil');
  assert.equal(normalizeItem({ id: 'f', user_name: 'Lily Lee' }).senderName, 'Lily');
  assert.equal(shortName(''), '');
  assert.equal(shortName(undefined, null), '');
});

test('card titles and sent lines use the short name', () => {
  const cards = groupIntoCards([
    { batch_id: 'B1', sender: { id: 'u3', name: 'Mike Lee', short_name: 'Mike' }, items: [{ id: 'x1', ready_at: 5 }, { id: 'x2', ready_at: 6 }, { id: 'x3', ready_at: 7 }] },
    item('s1', { user: { id: 'u2', name: 'Sarah Lee' }, ready_at: 1 }),
  ]);
  assert.deepEqual(cards.map(cardTitle), ['3 photos from Mike', 'Photo from Sarah']);
  assert.equal(sentLine('preset', cards[0].senderName), 'Your note is on its way to Mike.');
});

test('plain items are grouped by batch, newest batch first, a batch in shooting order', () => {
  const cards = groupIntoCards([
    item('m1', { batch_id: 'B1', ready_at: 10 }),
    item('m2', { batch_id: 'B1', ready_at: 12 }),
    item('m3', { batch_id: 'B1', ready_at: 11 }),
    item('s1', { kind: 'video', user: { name: 'Sarah' }, ready_at: 50 }),
    item('l1', { user: { name: 'Lily' }, ready_at: 30, caption: ' Meet Biscuit! He snores. ' }),
  ]);
  assert.deepEqual(cards.map(cardTitle), ['Video from Sarah', 'Photo from Lily', '3 photos from Mike']);
  assert.deepEqual(cards[2].items.map((i) => i.id), ['m1', 'm3', 'm2']);
});

test('cards the server already grouped keep their grouping and lend their sender', () => {
  const cards = groupIntoCards([
    { batch_id: 'B9', sender: { name: 'Mike' }, items: [{ id: 'x1', ready_at: 5 }, { id: 'x2', kind: 'video', ready_at: 6 }] },
  ]);
  assert.equal(cards.length, 1);
  assert.equal(cardTitle(cards[0]), 'A photo and a video from Mike');
});

test('seen items leave their card, and an empty card disappears', () => {
  const list = [item('m1', { batch_id: 'B1' }), item('m2', { batch_id: 'B1' }), item('z', { batch_id: 'B2' })];
  const cards = groupIntoCards(list, new Set(['m1', 'z']));
  assert.equal(cards.length, 1);
  assert.equal(cardTitle(cards[0]), 'Photo from Mike');
});

test('titles for mixed batches', () => {
  const mk = (kinds) => ({ senderName: 'Mike', items: kinds.map((kind) => ({ kind })) });
  assert.equal(cardTitle(mk(['video', 'video'])), '2 videos from Mike');
  assert.equal(cardTitle(mk(['photo', 'photo', 'video'])), '2 photos and a video from Mike');
  assert.equal(cardTitle(mk(['photo', 'video', 'video'])), 'A photo and 2 videos from Mike');
});

test('the second line quotes a single caption, else says when', () => {
  const one = { items: [{ kind: 'photo', caption: 'Meet Biscuit!' }] };
  assert.deepEqual(cardDetail(one, 'Yesterday'), { kind: 'quote', text: '“Meet Biscuit!”' });
  assert.deepEqual(cardDetail({ items: [{ kind: 'photo', caption: 'a' }, { kind: 'photo', caption: 'b' }] }, 'Yesterday'), { kind: 'when', text: 'Yesterday' });
  assert.deepEqual(cardDetail({ items: [{ kind: 'video', caption: 'Lily at the farm' }] }, 'This morning'), { kind: 'when', text: 'This morning' });
  assert.deepEqual(cardDetail({ items: [{ kind: 'photo', caption: 'x'.repeat(41) }] }, 'Sunday'), { kind: 'when', text: 'Sunday' });
});

test('the slideshow shows photos and video posters newest first', () => {
  const s = slideshowItems([item('a', { ready_at: 1 }), item('b', { ready_at: 3 }), item('v', { kind: 'video', ready_at: 9 })]);
  assert.deepEqual(s.map((i) => i.id), ['v', 'b', 'a'], 'videos stay reachable by their poster (F5)');
  assert.equal(s[0].display, s[0].poster);
  const posters = slideshowItems([item('v', { kind: 'video', renditions: { poster: '/p.jpg' } })]);
  assert.deepEqual(posters.map((i) => i.display), ['/p.jpg']);
});

test('sent lines use the name, never a guessed pronoun', () => {
  assert.equal(sentLine('react', 'Sarah', 'love'), 'Sarah will know you loved it.');
  assert.equal(sentLine('preset', 'Mike'), 'Your note is on its way to Mike.');
});

test('familyPhotoUrl accepts a URL, an item or nothing', () => {
  assert.equal(familyPhotoUrl('/f.jpg'), '/f.jpg');
  assert.equal(familyPhotoUrl(item('f')), '/media/f/display?v=1');
  assert.equal(familyPhotoUrl({ url: '/g.jpg' }), '/g.jpg');
  assert.equal(familyPhotoUrl(null, [{ display: '/first.jpg' }]), '/first.jpg');
  assert.equal(familyPhotoUrl(null, [{ kind: 'video', display: '/poster.jpg' }, { kind: 'photo', display: '/p.jpg' }]), '/p.jpg');
});
