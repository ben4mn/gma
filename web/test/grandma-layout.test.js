import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fitBox, heroLayout, openLayout, HERO, HERO_AREA, OPEN } from '../grandma/lib/layout.js';
import { shouldGoHome, shouldRest, canReload, canRedrawHome, HOME_SETTLE_MS, IDLE_MS } from '../grandma/lib/idle.js';

test('fitBox keeps the photo whole and its shape', () => {
  assert.deepEqual(fitBox(3000, 4000, 600, 600), { width: 450, height: 600 });
  assert.deepEqual(fitBox(4000, 3000, 600, 600), { width: 600, height: 450 });
  assert.deepEqual(fitBox(0, 0, 600, 400), { width: 600, height: 400 });
});

test('a portrait stands full height with room for its note', () => {
  const area = HERO_AREA;
  const { mode, photo } = heroLayout({ width: 3024, height: 4032 }, area);
  assert.equal(mode, 'portrait');
  assert.equal(photo.height, area.height - 2 * HERO.mat);
  assert.ok(photo.width + 2 * HERO.mat + HERO.gap + HERO.noteMin <= area.width);
  // larger than the Heirloom mock's 368x560 portrait
  assert.ok(photo.width * photo.height > 368 * 560 * 1.25);
});

test('a landscape spans the width with its caption on the mat, using most of the height', () => {
  const area = HERO_AREA;
  for (const [w, h] of [[4032, 3024], [1600, 1067]]) {
    const { mode, photo } = heroLayout({ width: w, height: h }, area);
    assert.equal(mode, 'landscape');
    const printHeight = photo.height + HERO.mat + HERO.caption;
    assert.ok(photo.width <= area.width - 2 * HERO.mat && printHeight <= area.height);
    assert.ok(printHeight >= area.height * 0.9, `${w}x${h}: the print is ${printHeight} of ${area.height} px tall`);
    // a third of the screen or more (Heirloom's mock had it at about a quarter)
    assert.ok(photo.width * photo.height >= 1280 * 800 * 0.34, `${w}x${h}: ${photo.width}x${photo.height}`);
  }
});

test('unknown dimensions fall back to landscape', () => {
  assert.equal(heroLayout({}, HERO_AREA).mode, 'landscape');
});

test('the open photo: a portrait stands the full cell height beside its note, much larger than before', () => {
  const { mode, photo } = openLayout({ width: 1000, height: 1500 });
  assert.equal(mode, 'pair');
  assert.equal(photo.height, OPEN.cell.height - 2 * OPEN.mat);
  assert.ok(photo.width * photo.height >= 277 * 416 * 1.4, `${photo.width}x${photo.height}`); // was 277x416
  const phone = openLayout({ width: 3024, height: 4032 });
  assert.deepEqual(phone.photo, { width: 375, height: 500 });
});

test('the open photo: landscapes and squares fill the cell above the buttons', () => {
  const land = openLayout({ width: 1600, height: 1067 });
  assert.equal(land.mode, 'cell');
  assert.equal(land.photo.width, OPEN.cell.width - 2 * OPEN.mat);
  const fourThree = openLayout({ width: 4032, height: 3024 });
  assert.ok(fourThree.photo.height > 416, 'taller than the old 416 px box');
  assert.equal(openLayout({ width: 800, height: 800 }).mode, 'cell');
  assert.equal(openLayout({}).mode, 'cell');
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
  // New cards wait while she is touching Home (F11).
  assert.equal(canRedrawHome({ screen: 'home', lastTouch: 0, now: HOME_SETTLE_MS - 1, busy: false }), false);
  assert.equal(canRedrawHome({ screen: 'home', lastTouch: 0, now: HOME_SETTLE_MS, busy: false }), true);
  assert.equal(canRedrawHome({ screen: 'home', lastTouch: 0, now: HOME_SETTLE_MS, busy: true }), false);
  assert.equal(canRedrawHome({ screen: 'item', lastTouch: 0, now: HOME_SETTLE_MS, busy: false }), false);
  assert.equal(canReload({ screen: 'home', lastTouch: 0, now: 1000, busy: false }), false);
});

test('a panorama stands in the middle of Home’s photo area; ordinary photos keep to the top', async () => {
  const pano = heroLayout({ width: 1600, height: 589 }, HERO_AREA); // the demo's p174.jpg, 2.7:1
  assert.equal(pano.mode, 'landscape');
  assert.equal(pano.centered, true);
  assert.equal(heroLayout({ width: 1600, height: 1067 }, HERO_AREA).centered, false); // 3:2 nearly fills it
  assert.equal(heroLayout({ width: 4032, height: 3024 }, HERO_AREA).centered, false);
  assert.equal(heroLayout({ width: 3024, height: 4032 }, HERO_AREA).centered, false); // portraits stand full height
});

test('the Sent print keeps the photo’s own shape, so a portrait is never cropped', async () => {
  const { sentLayout, SENT } = await import('../grandma/lib/layout.js');
  for (const [w, h] of [[3024, 4032], [1000, 1500], [4032, 3024], [1600, 589], [800, 800]]) {
    const box = sentLayout({ width: w, height: h });
    assert.ok(box.width <= SENT.width && box.height <= SENT.height, `${w}x${h}`);
    assert.ok(Math.abs(box.width / box.height - w / h) < 0.02, `${w}x${h}: ${box.width}x${box.height} keeps its shape`);
  }
  // a phone portrait uses the full height
  assert.equal(sentLayout({ width: 3024, height: 4032 }).height, SENT.height);
});
