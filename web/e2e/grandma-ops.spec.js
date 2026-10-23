// The frame's reliability fixes on the real app: a preset carries its words
// (F14), a frame booted with no internet shows no clock it can't trust and keeps
// the mode it last knew (OPS-8), the night line follows the hour (F15), and the
// Sent screen shows a portrait whole. Shots land in e2e/shots/.
import { test, expect } from '@playwright/test';
import { FRAME_URL, GRANDMA_VIEWPORT, audit, shoot } from './helpers.js';

async function pairedFrame(browser) {
  const context = await browser.newContext({ viewport: GRANDMA_VIEWPORT });
  const page = await context.newPage();
  await page.goto(FRAME_URL);
  await expect(page).toHaveURL(/\/grandma\/$/);
  await expect(page.locator('.hero img').first()).toBeVisible();
  return { context, page };
}

async function auditClean(page, name) {
  await page.waitForTimeout(400);
  await shoot(page, `grandma-${name}`);
  const result = await audit(page, 'grandma');
  expect(result.issues.map((i) => `${i.kind}: ${i.msg}`), name).toEqual([]);
}

test('a preset tap sends its words with it, so a preset Ben deletes later still arrives (F14)', async ({ browser }) => {
  const { context, page } = await pairedFrame(browser);
  await page.locator('.pcard').first().click();
  await page.getByRole('button', { name: 'Send a message' }).click();
  const preset = page.locator('.preset').first();
  const text = (await preset.textContent()).trim();
  const posted = page.waitForRequest((r) => r.url().endsWith('/api/frame/preset') && r.method() === 'POST');
  await preset.click();
  const body = (await posted).postDataJSON();
  expect(body.preset_text).toBe(text);
  expect(body.client_id).toBeTruthy();
  await context.close();
});

test('booted with no internet, the frame shows no clock it can’t trust and keeps the mode it knew (OPS-8)', async ({ browser }) => {
  const { context, page } = await pairedFrame(browser);
  await expect(page.locator('#clock-time')).not.toHaveText(''); // online: the server set the clock
  await page.evaluate(async () => {
    await navigator.serviceWorker.ready;
    for (let i = 0; i < 50 && !navigator.serviceWorker.controller; i += 1) await new Promise((r) => setTimeout(r, 100));
  });
  await page.waitForTimeout(1500); // the slideshow lands in the worker's cache
  // the worker took control after the first load; one state fetch through it
  // leaves the saved copy a real frame gets from its 5-minute refresh
  await page.evaluate(() => fetch('/api/frame/state', { cache: 'no-store' }).then((r) => r.text()));

  // the last mode it knew was day: it stays day, photos showing, no time at all
  await page.evaluate(() => localStorage.setItem('gma-frame-night', '0'));
  // Playwright's offline switch doesn't reach the service worker's own fetches:
  // refuse the server's state too, so the worker answers from its saved copy
  const noState = (route) => route.abort('internetdisconnected');
  await context.route('**/api/frame/state', noState);
  await context.setOffline(true);
  await page.goto(FRAME_URL);
  await expect(page.locator('#status')).toHaveText('No internet right now. Your saved photos keep showing.');
  await expect(page.locator('.hero img').first()).toBeVisible();
  await expect(page.locator('#clock-time')).toHaveText('');
  await expect(page.locator('#clock-date')).toHaveText('');
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'day');
  await auditClean(page, 'offline-boot');

  // the last mode it knew was night: it rests, and says nothing about the time
  await page.evaluate(() => localStorage.setItem('gma-frame-night', '1'));
  await page.goto(FRAME_URL);
  const rest = page.getByRole('button', { name: 'Wake the screen' });
  await expect(rest).toBeVisible();
  await expect(rest).toContainText('Resting for now.');
  await expect(page.locator('.rest-time')).toBeHidden();
  await auditClean(page, 'offline-boot-night');

  // the internet comes back: the server's time is trusted again
  await context.unroute('**/api/frame/state', noState);
  await context.setOffline(false);
  await page.evaluate(() => window.dispatchEvent(new Event('online')));
  await expect(page.locator('#clock-time')).not.toHaveText('', { timeout: 10_000 });
  await context.close();
});

test('at dawn the night line says good morning, and when the photos come back (F15)', async ({ browser }) => {
  const { context, page } = await pairedFrame(browser);
  await page.goto('/grandma/?fixture=1&state=night-awake&at=06:10');
  await expect(page.locator('#status')).toHaveText('Good morning. The photos come back at 7 am.');
  await auditClean(page, 'night-dawn');
  await page.goto('/grandma/?fixture=1&state=night&at=06:10');
  await expect(page.getByRole('button', { name: 'Wake the screen' })).toContainText('Good morning.');
  await expect(page.getByRole('button', { name: 'Wake the screen' })).toContainText('The photos will be back at 7 am.');
  await page.goto('/grandma/?fixture=1&state=night-awake&at=21:30');
  await expect(page.locator('#status')).toHaveText('Good evening. The slideshow rests until morning.');
  await context.close();
});

test('the Sent screen shows a portrait whole, heads and all', async ({ browser }) => {
  const { context, page } = await pairedFrame(browser);
  // open the slideshow and step to a portrait (the open screen pairs a portrait with its note)
  await page.locator('.hero').click();
  for (let i = 0; i < 12 && !(await page.locator('.viewer-main--pair').count()); i += 1) {
    await page.getByRole('button', { name: 'Next' }).click();
  }
  await expect(page.locator('.viewer-main--pair')).toBeVisible();
  await page.getByRole('button', { name: 'Love' }).click();
  const img = page.locator('.sent-print .print-photo img');
  await expect(img).toBeVisible();
  const { box, natural } = await img.evaluate(async (el) => {
    await el.decode().catch(() => {});
    return { box: { w: el.clientWidth, h: el.clientHeight }, natural: { w: el.naturalWidth, h: el.naturalHeight } };
  });
  expect(box.h).toBeGreaterThan(box.w); // the print stands upright
  expect(natural.w).toBeGreaterThan(0);
  expect(Math.abs(box.w / box.h - natural.w / natural.h)).toBeLessThan(0.03); // its own shape: nothing cropped
  await auditClean(page, 'sent-portrait');
  await context.close();
});
