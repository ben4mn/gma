import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatTime, dayLabel, whenLabel, formatDuration, dayKey, agoLabel } from '../shared/time.js';

const TZ = 'America/Chicago';
// 2026-10-22 10:42 in Chicago (UTC-5 in October)
const at = (iso) => Date.parse(iso);
const NOW = at('2026-10-22T15:42:00Z');

test('formatTime is lower-case with no leading zero', () => {
  assert.equal(formatTime(NOW, TZ), '10:42 am');
  assert.equal(formatTime(at('2026-10-22T00:05:00Z'), TZ), '7:05 pm');
  assert.equal(formatTime(at('2026-10-22T05:00:00Z'), TZ), '12:00 am');
  assert.equal(formatTime(at('2026-10-22T17:00:00Z'), TZ), '12:00 pm');
});

test('dayKey follows the zone, not UTC', () => {
  assert.equal(dayKey(at('2026-10-22T03:00:00Z'), TZ), '2026-10-21');
  assert.equal(dayKey(at('2026-10-22T03:00:00Z'), 'UTC'), '2026-10-22');
});

test('dayLabel names today, yesterday, the week, then dates', () => {
  assert.equal(dayLabel(at('2026-10-22T13:00:00Z'), NOW, TZ), 'Today');
  assert.equal(dayLabel(at('2026-10-22T03:00:00Z'), NOW, TZ), 'Yesterday');
  assert.equal(dayLabel(at('2026-10-18T18:00:00Z'), NOW, TZ), 'Sunday');
  assert.equal(dayLabel(at('2026-10-03T18:00:00Z'), NOW, TZ), 'October 3');
  assert.equal(dayLabel(at('2025-12-24T18:00:00Z'), NOW, TZ), 'December 24, 2025');
});

test('whenLabel shows the time today and the day before', () => {
  assert.equal(whenLabel(at('2026-10-22T14:58:00Z'), NOW, TZ), '9:58 am');
  assert.equal(whenLabel(at('2026-10-21T14:58:00Z'), NOW, TZ), 'Yesterday');
});

test('formatDuration', () => {
  assert.equal(formatDuration(42_000), '0:42');
  assert.equal(formatDuration(62_400), '1:02');
  assert.equal(formatDuration(3_723_000), '1:02:03');
  assert.equal(formatDuration(undefined), '0:00');
});

test('agoLabel', () => {
  assert.equal(agoLabel(NOW - 10_000, NOW, TZ), 'just now');
  assert.equal(agoLabel(NOW - 60_000, NOW, TZ), '1 minute ago');
  assert.equal(agoLabel(NOW - 3 * 3_600_000, NOW, TZ), '3 hours ago');
  assert.equal(agoLabel(at('2026-10-20T14:00:00Z'), NOW, TZ), 'Tuesday at 9:00 am');
});
