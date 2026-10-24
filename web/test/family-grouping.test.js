import { test } from 'node:test';
import assert from 'node:assert/strict';
import { groupByDay, mergeIntoPosts, removeFromPosts } from '../app/grouping.js';

const TZ = 'America/Chicago';
const NOW = Date.parse('2026-10-22T15:42:00Z');

test('groupByDay keeps order and labels days', () => {
  const entries = [
    { id: 'a', created_at: Date.parse('2026-10-22T15:00:00Z') },
    { id: 'b', created_at: Date.parse('2026-10-22T14:00:00Z') },
    { id: 'c', created_at: Date.parse('2026-10-21T20:00:00Z') },
    { id: 'd', created_at: Date.parse('2026-10-18T20:00:00Z') },
  ];
  const groups = groupByDay(entries, { now: NOW, timeZone: TZ });
  assert.deepEqual(groups.map((g) => [g.label, g.entries.map((e) => e.id).join('')]), [['Today', 'ab'], ['Yesterday', 'c'], ['Sunday', 'd']]);
});

const item = (id, batch, user = 'u1') => ({ id, batch_id: batch, user: { id: user } });

test('mergeIntoPosts folds a batch into one post', () => {
  const { posts, firstChanged } = mergeIntoPosts([], [item('1', 'b1'), item('2', 'b1'), item('3', null), item('4', 'b2', 'u2'), item('5', 'b2', 'u3')]);
  assert.deepEqual(posts.map((p) => p.items.map((i) => i.id).join('')), ['12', '3', '4', '5']);
  assert.equal(firstChanged, 0);
});

test('a batch straddling two pages re-renders from its post', () => {
  const first = mergeIntoPosts([], [item('1', null), item('2', 'b1')]);
  const second = mergeIntoPosts(first.posts, [item('3', 'b1'), item('4', null)]);
  assert.equal(second.firstChanged, 1);
  assert.deepEqual(second.posts.map((p) => p.items.length), [1, 2, 1]);
});

test('duplicates from a refetch are ignored, and removal drops empty posts', () => {
  const { posts } = mergeIntoPosts([], [item('1', 'b'), item('2', 'b'), item('3', null)]);
  const again = mergeIntoPosts(posts, [item('3', null)]);
  assert.equal(again.posts.length, 2);
  assert.equal(again.firstChanged, 2);
  const left = removeFromPosts(removeFromPosts(posts, '3'), '1');
  assert.deepEqual(left.map((p) => p.items.map((i) => i.id)), [['2']]);
});
