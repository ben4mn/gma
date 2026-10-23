import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renditionUrl, readPage, recipientLabel, colourFor, firstName, initialOf, grandmaOn } from '../app/data.js';

test('renditionUrl prefers the server URL and falls back to the contract path', () => {
  assert.equal(renditionUrl({ id: 'A', renditions: { thumb: { url: '/media/A/thumb?v=1' } } }, 'thumb'), '/media/A/thumb?v=1');
  assert.equal(renditionUrl({ id: 'A', renditions: [{ name: 'large', url: '/x' }] }, 'large'), '/x');
  assert.equal(renditionUrl({ id: 'A', ready_at: 99 }, 'display'), '/media/A/display?v=99');
  assert.equal(renditionUrl({ id: 'A', renditions: { thumb: '/t' } }, 'poster'), null);
});

test('readPage finds the list and the cursor', () => {
  assert.deepEqual(readPage({ items: [{ id: 'a' }], next_before: 'a' }, 'items', 30), { list: [{ id: 'a' }], next: 'a' });
  assert.deepEqual(readPage({ events: [{ id: 'a' }, { id: 'b' }] }, 'events', 2), { list: [{ id: 'a' }, { id: 'b' }], next: 'b' });
  assert.deepEqual(readPage({ events: [{ id: 'a' }] }, 'events', 2), { list: [{ id: 'a' }], next: null });
  assert.deepEqual(readPage({ items: [], next: null }, 'items', 2), { list: [], next: null });
});

test('recipientLabel', () => {
  const me = { id: 'u1' };
  assert.deepEqual(recipientLabel({ recipient: null }, me), { everyone: true, text: 'To everyone' });
  assert.equal(recipientLabel({ recipient: { id: 'u1', name: 'Sarah' } }, me).text, 'To you');
  assert.equal(recipientLabel({ recipient: { id: 'u2', name: 'Mike Lee' } }, me).text, 'To Mike');
});

test('names and colours', () => {
  assert.equal(firstName('  Aunt Carol '), 'Aunt');
  assert.equal(initialOf('sarah'), 'S');
  assert.equal(colourFor({ color: '#3A5236' }), '#3A5236');
  assert.equal(colourFor({ id: 'x' }), colourFor({ id: 'x' }));
  assert.match(colourFor({ id: 'y', color: 'sage' }), /^#[0-9A-F]{6}$/);
});

test('grandmaOn sorts oldest first', () => {
  const item = { grandma_events: [{ created_at: 2 }, { created_at: 1 }] };
  assert.deepEqual(grandmaOn(item).map((e) => e.created_at), [1, 2]);
});
