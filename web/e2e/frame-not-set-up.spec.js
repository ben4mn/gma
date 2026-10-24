// The "This frame isn't set up yet" page on Grandma's 1280x800 kiosk: Heirloom
// paper and ink from its own stylesheet (the CSP allows nothing inline), large
// calm text, nothing to tap, nothing scrolls, no cookie. Shot lands in e2e/shots/.
import { test, expect } from '@playwright/test';
import { GRANDMA_VIEWPORT, shoot } from './helpers.js';

test('an unknown pairing link shows a calm Heirloom page with nothing to tap', async ({ browser }) => {
  const context = await browser.newContext({ viewport: GRANDMA_VIEWPORT });
  const page = await context.newPage();
  const blocked = [];
  page.on('console', (msg) => { if (/Content Security Policy|Refused to/i.test(msg.text())) blocked.push(msg.text()); });

  const res = await page.goto('/grandma?device=not-a-real-token-at-all-xxxxxxxx');
  expect(res.status()).toBe(403);
  expect(res.headers()['cache-control']).toBe('no-store, no-transform');
  await expect(page.getByRole('heading', { name: /This frame isn.t set up yet\./ })).toBeVisible();
  await expect(page.getByText('Ben can fix this.')).toBeVisible();
  await page.evaluate(() => document.fonts.ready);

  const look = await page.evaluate(() => {
    const css = (el) => getComputedStyle(el);
    const h1 = document.querySelector('h1');
    const p = document.querySelector('p');
    return {
      background: css(document.documentElement).backgroundColor,
      ink: css(h1).color,
      h1Size: parseFloat(css(h1).fontSize),
      h1Font: css(h1).fontFamily,
      pSize: parseFloat(css(p).fontSize),
      pFont: css(p).fontFamily,
      tappable: document.querySelectorAll('button, a, input, select, textarea, [onclick], [tabindex]').length,
      scrolls: document.documentElement.scrollHeight > innerHeight || document.documentElement.scrollWidth > innerWidth,
    };
  });
  expect(look.background).toBe('rgb(245, 238, 226)'); // --paper
  expect(look.ink).toBe('rgb(43, 33, 25)'); // --ink
  expect(look.h1Size).toBeGreaterThanOrEqual(56);
  expect(look.h1Font).toMatch(/Fraunces/);
  expect(look.pSize).toBeGreaterThanOrEqual(32);
  expect(look.pFont).toMatch(/Atkinson Hyperlegible Next/);
  expect(look.tappable).toBe(0);
  expect(look.scrolls).toBe(false);
  expect(blocked).toEqual([]);
  expect(await context.cookies()).toEqual([]);

  await shoot(page, 'grandma-not-set-up');
  await context.close();
});
