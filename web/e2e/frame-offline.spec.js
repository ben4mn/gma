// After a power cut the kiosk opens the pairing link, /grandma?device=…, before
// the internet is back. The frame's service worker (scope /grandma) must answer
// that link from its cache: the saved frame, not Chromium's error page.
import { test, expect } from '@playwright/test';
import { FRAME_URL, GRANDMA_VIEWPORT } from './helpers.js';

test('the pairing link opens the saved frame with no internet', async ({ browser }) => {
  const context = await browser.newContext({ viewport: GRANDMA_VIEWPORT });
  const page = await context.newPage();

  // online: the server pairs the frame and sends it on to /grandma/
  await page.goto(FRAME_URL);
  await expect(page).toHaveURL(/\/grandma\/$/);
  await expect(page.locator('.hero img').first()).toBeVisible();

  // the frame's worker controls /grandma itself (the server allows the wider scope)
  const sw = await page.request.get('/grandma/sw.js');
  expect(sw.headers()['service-worker-allowed']).toBe('/grandma');
  const scope = await page.evaluate(async () => {
    await navigator.serviceWorker.ready;
    for (let i = 0; i < 50 && !navigator.serviceWorker.controller; i += 1) await new Promise((r) => setTimeout(r, 100));
    const reg = await navigator.serviceWorker.getRegistration('/grandma');
    return reg ? new URL(reg.scope).pathname : null;
  });
  expect(scope).toBe('/grandma');
  // let the slideshow's photos land in the worker's cache
  await page.waitForTimeout(1500);

  // the power comes back before the internet does
  await context.setOffline(true);
  await page.goto(FRAME_URL);
  await expect(page).toHaveURL(/\/grandma\/$/); // the token never stays in the address bar
  await expect(page.locator('[data-home]')).toBeVisible();
  await expect(page.locator('.hero img').first()).toBeVisible();
  // the state came from the worker's saved copy, so the worker really was offline too
  await expect(page.locator('#status')).toHaveText('No internet right now. Your saved photos keep showing.');

  await context.setOffline(false);
  await context.close();
});
