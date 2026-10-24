// Accessibility audit of the real Grandma screens (the checks from
// design/tools/shoot.py at this build's thresholds) plus screenshots of every
// Grandma state and the three family tabs in e2e/shots/ for a look by eye.
import { test, expect } from '@playwright/test';
import {
  FAMILY_VIEWPORT, FRAME_URL, GRANDMA_VIEWPORT,
  audit, setNight, shoot, signInWithCode, skipPasskeyOffer, watchExternal,
} from './helpers.js';

const DEMO_MEMBER = 'sarah@demo.invalid';

test.describe.serial('Grandma screens: audit and screenshots', () => {
  let family; // a demo member's phone
  let admin; // Ben's phone, for night hours
  let frame;
  const externalLists = [];
  const failures = [];

  async function newPage(browser, viewport) {
    const context = await browser.newContext({ viewport });
    const page = await context.newPage();
    externalLists.push(watchExternal(page));
    return page;
  }

  async function check(page, surface, name) {
    await page.waitForTimeout(400); // let fades settle before the shot
    await shoot(page, `${surface}-${name}`);
    const result = await audit(page, surface);
    expect(result.measured, `${name}: the audit measured some text`).toBeGreaterThan(0);
    expect(result.taps, `${name}: the audit found tap targets`).toBeGreaterThan(0);
    for (const issue of result.issues) failures.push(`${name}: ${issue.kind}: ${issue.msg}`);
    return result;
  }

  test.beforeAll(async ({ browser }) => {
    admin = await newPage(browser, FAMILY_VIEWPORT);
    await signInWithCode(admin, 'ben@example.com');
    await skipPasskeyOffer(admin);
    await setNight(admin.request, { asleep: false });
    family = await newPage(browser, FAMILY_VIEWPORT);
    await signInWithCode(family, DEMO_MEMBER);
    await skipPasskeyOffer(family);
    frame = await newPage(browser, GRANDMA_VIEWPORT);
  });

  test.afterAll(async () => {
    for (const page of [admin, family, frame]) await page?.context().close();
  });

  test('the family tabs', async () => {
    await family.goto('/');
    await expect(family.getByRole('heading', { name: 'Family', exact: true })).toBeVisible();
    await expect(family.locator('article img').first()).toBeVisible();
    await check(family, 'family', 'tab-family');
    await family.goto('/from-grandma');
    await expect(family.getByRole('heading', { name: 'Grandma’s Feed' })).toBeVisible();
    await check(family, 'family', 'tab-grandmas-feed');
    await family.goto('/mine');
    await expect(family.getByRole('heading', { name: 'Mine' })).toBeVisible();
    await check(family, 'family', 'tab-mine');
  });

  test('home, a photo, the messages, sent, voice', async () => {
    await frame.goto(FRAME_URL);
    await expect(frame.locator('.hero img').first()).toBeVisible();
    await check(frame, 'grandma', 'home');

    await frame.locator('.pcard').first().click();
    await expect(frame.getByRole('button', { name: 'Love' })).toBeVisible();
    await check(frame, 'grandma', 'item');

    await frame.getByRole('button', { name: 'Send a message' }).click();
    await expect(frame.locator('.preset').first()).toBeVisible();
    await check(frame, 'grandma', 'presets');

    await frame.locator('.preset').first().click();
    await expect(frame.locator('.sent')).toBeVisible();
    await check(frame, 'grandma', 'sent');

    await frame.getByRole('button', { name: 'Home' }).click();
    await frame.locator('button.voice').click();
    await expect(frame.locator('#screen')).toContainText(/whole family/i);
    await check(frame, 'grandma', 'voice');
    await frame.getByRole('button', { name: 'Home' }).click();
  });

  test('offline: one calm line, photos keep showing', async () => {
    await frame.context().setOffline(true);
    await frame.evaluate(() => window.dispatchEvent(new Event('offline')));
    await expect(frame.locator('#status')).toHaveText('No internet right now. Your saved photos keep showing.');
    await check(frame, 'grandma', 'offline');
    await frame.context().setOffline(false);
    await frame.evaluate(() => window.dispatchEvent(new Event('online')));
    await expect(frame.locator('#status')).toBeHidden();
  });

  test('night: dimmed, a calm clock, the first tap only wakes', async () => {
    await setNight(admin.request, { asleep: true });
    await frame.reload();
    const rest = frame.getByRole('button', { name: 'Wake the screen' });
    await expect(rest).toBeVisible();
    await check(frame, 'grandma', 'night');
    await rest.click();
    await expect(rest).toBeHidden();
    await check(frame, 'grandma', 'night-awake');
    await setNight(admin.request, { asleep: false });
  });

  test('every Grandma screen passes the audit and nothing leaves the app', () => {
    expect(externalLists.flat(), 'requests that left the app').toEqual([]);
    expect(failures, failures.join('\n')).toEqual([]);
  });
});
