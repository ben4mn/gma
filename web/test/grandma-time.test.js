import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  formatTime, formatDate, parseHm, isNightMinutes, isNightAt, whenLabel, formatCountdown, durationWords,
} from '../grandma/lib/time.js';

const TZ = 'America/Chicago';
// 2026-10-21 is a Wednesday; Chicago is UTC-5 (CDT) on that date.
const at = (hh, mm, day = 21) => Date.UTC(2026, 9, day, hh + 5, mm);

test('formatTime writes "10:42 am" in the family timezone', () => {
  assert.equal(formatTime(at(10, 42), TZ), '10:42 am');
  assert.equal(formatTime(at(21, 30), TZ), '9:30 pm');
  assert.equal(formatTime(at(0, 5), TZ), '12:05 am');
  assert.equal(formatTime(at(12, 0), TZ), '12:00 pm');
  assert.equal(formatTime(at(10, 42), 'UTC'), '3:42 pm');
});

test('formatDate writes the weekday and the day', () => {
  assert.equal(formatDate(at(10, 42), TZ), 'Wednesday, October 21');
});

test('parseHm reads HH:MM and rejects nonsense', () => {
  assert.equal(parseHm('21:00'), 1260);
  assert.equal(parseHm('7:05'), 425);
  assert.equal(parseHm('24:00'), null);
  assert.equal(parseHm('soon'), null);
  assert.equal(parseHm(undefined), null);
});

test('the night window crosses midnight', () => {
  const start = parseHm('21:00');
  const end = parseHm('07:00');
  assert.equal(isNightMinutes(parseHm('20:59'), start, end), false);
  assert.equal(isNightMinutes(parseHm('21:00'), start, end), true);
  assert.equal(isNightMinutes(parseHm('23:59'), start, end), true);
  assert.equal(isNightMinutes(parseHm('00:00'), start, end), true);
  assert.equal(isNightMinutes(parseHm('06:59'), start, end), true);
  assert.equal(isNightMinutes(parseHm('07:00'), start, end), false);
  assert.equal(isNightMinutes(parseHm('12:00'), start, end), false);
});

test('a night window inside one day, an empty one, and a broken one', () => {
  assert.equal(isNightMinutes(parseHm('01:30'), parseHm('01:00'), parseHm('05:00')), true);
  assert.equal(isNightMinutes(parseHm('05:00'), parseHm('01:00'), parseHm('05:00')), false);
  assert.equal(isNightMinutes(600, 600, 600), false);
  assert.equal(isNightMinutes(600, null, 420), false);
});

test('isNightAt uses the settings timezone, not the machine one', () => {
  const settings = { night_start: '21:00', night_end: '07:00', timezone: TZ };
  assert.equal(isNightAt(at(21, 30), settings), true);
  assert.equal(isNightAt(at(6, 30), settings), true);
  assert.equal(isNightAt(at(10, 42), settings), false);
  // 02:00 UTC is 9 pm in Chicago
  assert.equal(isNightAt(Date.UTC(2026, 9, 22, 2, 0), settings), true);
});

test('whenLabel says it the way a person would', () => {
  const now = at(15, 0);
  assert.equal(whenLabel(at(8, 0), now, TZ), 'This morning');
  assert.equal(whenLabel(at(13, 0), now, TZ), 'This afternoon');
  assert.equal(whenLabel(at(19, 0), at(20, 0), TZ), 'This evening');
  assert.equal(whenLabel(at(23, 0, 20), now, TZ), 'Yesterday');
  assert.equal(whenLabel(at(9, 0, 17), now, TZ), 'Saturday');
  assert.equal(whenLabel(at(9, 0, 3), now, TZ), 'October 3');
  assert.equal(whenLabel(Date.UTC(2025, 4, 1, 17), now, TZ), 'May 1, 2025');
});

test('yesterday is a calendar day, not 24 hours', () => {
  // 11:50 pm Tuesday seen at 12:10 am Wednesday is "Yesterday"
  assert.equal(whenLabel(at(23, 50, 20), at(0, 10, 21), TZ), 'Yesterday');
});

test('formatCountdown rounds up and never goes below zero', () => {
  assert.equal(formatCountdown(60_000), '1:00');
  assert.equal(formatCountdown(41_200), '0:42');
  assert.equal(formatCountdown(1), '0:01');
  assert.equal(formatCountdown(0), '0:00');
  assert.equal(formatCountdown(-500), '0:00');
});

test('durationWords for the play plate', () => {
  assert.equal(durationWords(62_000), '1 minute');
  assert.equal(durationWords(150_000), '3 minutes');
  assert.equal(durationWords(44_000), '45 seconds');
  assert.equal(durationWords(4_000), 'a few seconds');
  assert.equal(durationWords(null), '');
});
