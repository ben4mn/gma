import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fitBox, heroLayout } from '../grandma/lib/layout.js';
import { shouldGoHome, shouldRest, canReload, IDLE_MS } from '../grandma/lib/idle.js';

test('fitBox keeps the photo whole and its shape', () => {
  assert.deepEqual(fitBox(3000, 4000, 600, 600), { width: 450, height: 600 });
  assert.deepEqual(fitBox(4000, 3000, 600, 600), { width: 600, height: 450 });
  assert.deepEqual(fitBox(0, 0, 600, 400), { width: 600, height: 400 });
});

test('a portrait stands full height with room for its note', () => {
  const area = { width: 760, height: 640 };
  const { mode, photo } = heroLayout({ width: 3024, height: 4032 }, area);
  assert.equal(mode, 'portrait');
  assert.ok(photo.height >= 590 && photo.height <= 604);
  assert.ok(photo.width + 36 + 28 + 250 <= area.width);
  // larger than the Heirloom mock's 368x560 portrait
  assert.ok(photo.width * photo.height > 368 * 560 * 1.25);
});

test('a landscape spans the width with its caption on the mat', () => {
  const area = { width: 760, height: 640 };
  const { mode, photo } = heroLayout({ width: 4032, height: 3024 }, area);
  assert.equal(mode, 'landscape');
  assert.ok(photo.width <= 724 && photo.height + 18 + 96 <= 640);
  assert.ok(photo.width * photo.height > 664 * 446 * 1.2);
});

test('unknown dimensions fall back to landscape', () => {
  assert.equal(heroLayout({}, { width: 760, height: 640 }).mode, 'landscape');
});

test('idle: back Home after 2 minutes, but not while something plays or records', () => {
  const base = { screen: 'item', lastTouch: 0, busy: false };
  assert.equal(shouldGoHome({ ...base, now: IDLE_MS - 1 }), false);
  assert.equal(shouldGoHome({ ...base, now: IDLE_MS }), true);
  assert.equal(shouldGoHome({ ...base, now: IDLE_MS, busy: true }), false);
  assert.equal(shouldGoHome({ ...base, now: IDLE_MS, screen: 'home' }), false);
});

test('night: an awake Home rests again; reloads wait for Home and quiet', () => {
  const base = { night: true, resting: false, screen: 'home', lastTouch: 0, now: IDLE_MS, busy: false };
  assert.equal(shouldRest(base), true);
  assert.equal(shouldRest({ ...base, night: false }), false);
  assert.equal(shouldRest({ ...base, resting: true }), false);
  assert.equal(shouldRest({ ...base, screen: 'voice' }), false);
  assert.equal(canReload({ screen: 'home', lastTouch: 0, now: IDLE_MS, busy: false }), true);
  assert.equal(canReload({ screen: 'item', lastTouch: 0, now: IDLE_MS, busy: false }), false);
  assert.equal(canReload({ screen: 'home', lastTouch: 0, now: 1000, busy: false }), false);
});
