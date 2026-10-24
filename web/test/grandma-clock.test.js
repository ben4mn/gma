// The frame's clock after a power cut with no internet (OPS-8), and what it
// says at night by the hour it really is (F15).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createFrameClock, nightMode, CLOCK_STEP_MS } from '../grandma/lib/clock.js';
import { nightWords, greetingAt, hmWords, secondsWords } from '../grandma/lib/time.js';

const TZ = 'America/Chicago';
const SETTINGS = { night_start: '21:00', night_end: '07:00', timezone: TZ };
// 2026-10-21; Chicago is UTC-5 (CDT) on that date.
const at = (hh, mm) => Date.UTC(2026, 9, 21, hh + 5, mm);

function fakeMachine(wallStart) {
  let wall = wallStart;
  let mono = 0;
  return {
    wall: () => wall,
    mono: () => mono,
    run(ms) { wall += ms; mono += ms; },
    setClock(ms) { wall = ms; }, // NTP steps the system clock
  };
}

test('booted offline on a stale clock: not trusted, so no time and no mode change', () => {
  const m = fakeMachine(at(14, 5)); // the Pi thinks it is 2:05 pm; it is really 5 pm
  const clock = createFrameClock(m);
  assert.equal(clock.trusted, false);
  m.run(60_000);
  assert.equal(clock.check(), false, 'ordinary running is not a jump');
  assert.equal(clock.trusted, false);
  assert.equal(nightMode({ trusted: clock.trusted, night: false, lastKnown: true }), true, 'keeps the night it knew');
  assert.equal(nightMode({ trusted: clock.trusted, night: true, lastKnown: false }), false, 'keeps the day it knew');
});

test('the server time makes the clock right, and the offset is kept', () => {
  const m = fakeMachine(at(14, 5));
  const clock = createFrameClock(m);
  clock.sync(at(17, 0));
  assert.equal(clock.trusted, true);
  assert.equal(clock.now(), at(17, 0));
  m.run(90_000);
  assert.equal(clock.now(), at(17, 0) + 90_000);
  assert.equal(nightMode({ trusted: clock.trusted, night: true, lastKnown: false }), true);
});

test('NTP setting the system clock makes it trusted, and never makes a synced clock jump', () => {
  const m = fakeMachine(at(14, 5));
  const clock = createFrameClock(m);
  m.run(30_000);
  m.setClock(at(17, 1));
  assert.equal(clock.check(), true);
  assert.equal(clock.trusted, true);
  assert.equal(clock.now(), at(17, 1));

  const synced = fakeMachine(at(14, 5));
  const c2 = createFrameClock(synced);
  c2.sync(at(17, 0)); // offset of about +3 hours
  synced.run(1000);
  synced.setClock(at(17, 0) + 1000 + 50); // NTP catches the Pi up
  assert.equal(c2.check(), true);
  assert.ok(Math.abs(c2.now() - (at(17, 0) + 1000)) <= 50, 'the time on screen stays put');
  assert.ok(CLOCK_STEP_MS >= 60_000);
});

test('at dawn the frame says good morning, not good evening (F15)', () => {
  assert.equal(greetingAt(at(6, 0), TZ), 'Good morning');
  assert.equal(greetingAt(at(21, 30), TZ), 'Good evening');
  assert.equal(greetingAt(at(2, 0), TZ), 'Good night');
  assert.equal(greetingAt(at(14, 0), TZ), 'Good afternoon');

  const dawn = nightWords(at(6, 0), SETTINGS);
  assert.equal(dawn.status, 'Good morning. The photos come back at 7 am.');
  assert.equal(dawn.restTitle, 'Good morning.');
  assert.equal(dawn.restLine, 'The photos will be back at 7 am.');
  const evening = nightWords(at(21, 30), SETTINGS);
  assert.equal(evening.status, 'Good evening. The slideshow rests until morning.');
  assert.equal(evening.restLine, 'The photos will be back in the morning.');
  assert.equal(nightWords(at(1, 0), { ...SETTINGS, night_end: '06:30' }).status, 'Good night. The photos come back at 6:30 am.');
  // the greeting follows the family's timezone, not the Pi's
  assert.equal(greetingAt(at(6, 0), 'Europe/London'), 'Good afternoon'); // 6 am in Chicago is noon in London
});

test('with a clock it can not trust, the night words say nothing about the time', () => {
  const words = nightWords(at(14, 5), SETTINGS, { trusted: false });
  for (const text of Object.values(words)) assert.doesNotMatch(text, /morning|evening|night|am|pm/i);
});

test('small words: hours and seconds read naturally', () => {
  assert.equal(hmWords('07:00'), '7 am');
  assert.equal(hmWords('06:30'), '6:30 am');
  assert.equal(hmWords('12:00'), '12 pm');
  assert.equal(hmWords('nope'), '');
  assert.equal(secondsWords(1), '1 second');
  assert.equal(secondsWords(12), '12 seconds');
});
