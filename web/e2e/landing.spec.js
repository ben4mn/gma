// The public landing page at / (signed out): it renders on a phone and a
// desktop, logs no errors, asks nothing of another origin, passes the family
// audit (44 px targets, 13 px text, AA contrast) all the way down, never scrolls
// sideways at 360 px, and its Sign in link opens the sign-in screen.
// Screenshots: web/e2e/shots/landing-phone.png and landing-desktop.png.
//
// LANDING_CAPTURE=1 bash e2e/run.sh landing.spec.js also remakes the two
// pictures on the page (web/assets/landing/*.webp) from the real app: the
// frame's Home at 1280x800 (its fixture, at 10:42 am, with the sample photos)
// and Grandma's Feed at 390x844 (the seeded demo family, signed in as the admin).
import fs from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { test, expect } from '@playwright/test';
import { audit, FRAME_URL, shoot, signInWithCode, skipPasskeyOffer, ADMIN_EMAIL, watchExternal } from './helpers.js';

const WEB = path.resolve(import.meta.dirname, '..');
const REPO = path.resolve(WEB, '..');
const OUT = path.join(WEB, 'assets', 'landing');

const VIEWPORTS = {
  phone: { width: 390, height: 844 },
  desktop: { width: 1280, height: 800 },
};

/** Console errors and page errors (a CSP violation is a console error). */
function watchErrors(page) {
  const errors = [];
  page.on('console', (msg) => { if (msg.type() === 'error') errors.push(msg.text()); });
  page.on('pageerror', (err) => errors.push(String(err)));
  return errors;
}

/** The family audit, one screenful at a time from the top of the page to the bottom. */
async function auditWholePage(page) {
  const issues = [];
  let measured = 0;
  const height = await page.evaluate(() => document.scrollingElement.scrollHeight);
  const step = page.viewportSize().height;
  for (let y = 0; y < height; y += step) {
    await page.evaluate((top) => window.scrollTo(0, top), y);
    const result = await audit(page, 'family');
    measured += result.measured;
    for (const issue of result.issues) issues.push(`${issue.kind} @${y}: ${issue.msg}`);
  }
  await page.evaluate(() => window.scrollTo(0, 0));
  return { issues: [...new Set(issues)], measured };
}

for (const [name, viewport] of Object.entries(VIEWPORTS)) {
  test(`landing page on a ${name} (${viewport.width}x${viewport.height})`, async ({ browser }) => {
    const context = await browser.newContext({ viewport, deviceScaleFactor: 2 });
    const page = await context.newPage();
    const external = watchExternal(page);
    const errors = watchErrors(page);

    const res = await page.goto('/');
    expect(res.status()).toBe(200);
    expect(page.url()).toMatch(/\/$/);
    expect(res.headers()['x-robots-tag']).toBe('noindex, nofollow');
    await expect(page.locator('meta[name="robots"]')).toHaveAttribute('content', 'noindex, nofollow');
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Sign in', exact: true }).first()).toBeVisible();
    await expect(page.getByText('Got an invite? Open the link in your email.')).toBeVisible();

    // Every picture loaded (lazy ones once scrolled to) and is described.
    const imgs = page.locator('img');
    for (let i = 0; i < (await imgs.count()); i += 1) {
      const img = imgs.nth(i);
      await img.scrollIntoViewIfNeeded();
      await expect(img).toHaveAttribute('alt', /.{12,}/);
      await expect.poll(() => img.evaluate((el) => el.complete && el.naturalWidth > 0)).toBe(true);
    }
    await page.evaluate(() => document.fonts.ready.then(() => true));

    const result = await auditWholePage(page);
    expect(result.measured).toBeGreaterThan(10);
    expect(result.issues, result.issues.join('\n')).toEqual([]);

    const overflow = await page.evaluate(() => document.scrollingElement.scrollWidth - innerWidth);
    expect(overflow).toBeLessThanOrEqual(0);

    await page.screenshot({ path: path.join(WEB, 'e2e', 'shots', `landing-${name}.png`), fullPage: true });
    // The landing page itself: no errors, nothing from another origin. (The
    // sign-in screen after it logs its own signed-out 401 from /api/me.)
    expect(errors).toEqual([]);
    expect(external).toEqual([]);

    await page.getByRole('link', { name: 'Sign in', exact: true }).first().click();
    await expect(page).toHaveURL(/\/signin$/);
    await expect(page.getByLabel('Your email')).toBeVisible();
    expect(external).toEqual([]);
    await context.close();
  });
}

test('landing page at 360 px never scrolls sideways', async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 360, height: 740 } });
  const page = await context.newPage();
  await page.goto('/');
  await page.evaluate(() => document.fonts.ready.then(() => true));
  expect(await page.evaluate(() => document.scrollingElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(0);
  const { issues } = await auditWholePage(page);
  expect(issues, issues.join('\n')).toEqual([]);
  await context.close();
});

// ---------- LANDING_CAPTURE=1: remake the page's two screenshots ----------

const capture = process.env.LANDING_CAPTURE === '1';

async function toWebp(png, base, widths, quality) {
  const sharp = createRequire(path.join(REPO, 'server', 'package.json'))('sharp');
  await fs.mkdir(OUT, { recursive: true });
  for (const width of widths) {
    const file = path.join(OUT, `${base}-${width}.webp`);
    await sharp(png).resize({ width }).webp({ quality, effort: 6, smartSubsample: true }).toFile(file);
    const { size } = await fs.stat(file);
    expect(size, `${file} is ${size} bytes`).toBeLessThanOrEqual(200 * 1024);
  }
}

test.describe('capture', () => {
  test.skip(!capture, 'set LANDING_CAPTURE=1 to remake web/assets/landing/*.webp');

  test("the frame's Home, 1280x800", async ({ browser }) => {
    const context = await browser.newContext({ viewport: VIEWPORTS.desktop, deviceScaleFactor: 2 });
    const page = await context.newPage();
    // The fixture's photos are the design's samples (Unsplash placeholders).
    await page.route('**/design/assets/photos/*', (route) => {
      const name = path.basename(new URL(route.request().url()).pathname);
      return route.fulfill({ path: path.join(REPO, 'design', 'assets', 'photos', name), contentType: 'image/jpeg' });
    });
    await page.goto(FRAME_URL); // pairs this browser as the frame
    await page.goto('/grandma/?fixture=1&at=10:42');
    await expect(page.locator('#clock-time')).toHaveText(/10:42/);
    await page.evaluate(() => document.fonts.ready.then(() => true));
    await expect.poll(() => page.evaluate(() => [...document.images].every((i) => i.complete && i.naturalWidth > 0))).toBe(true);
    await page.waitForTimeout(1800); // past the first crossfade
    const png = await page.screenshot();
    await shoot(page, 'landing-capture-frame');
    await toWebp(png, 'frame-home', [1280, 640], 78);
    await context.close();
  });

  test("Grandma's Feed on a phone, 390x844", async ({ browser }) => {
    const context = await browser.newContext({ viewport: VIEWPORTS.phone, deviceScaleFactor: 2, timezoneId: 'America/Chicago' });
    const page = await context.newPage();
    await signInWithCode(page, ADMIN_EMAIL);
    await skipPasskeyOffer(page);
    await page.goto('/from-grandma');
    await expect(page.getByRole('heading', { name: 'Grandma’s Feed' })).toBeVisible();
    await page.evaluate(() => document.fonts.ready.then(() => true));
    await expect.poll(() => page.evaluate(() => [...document.images].every((i) => i.complete && i.naturalWidth > 0))).toBe(true);
    // Any one-time prompt (install, notifications) stays out of the picture.
    const png = await page.screenshot();
    await shoot(page, 'landing-capture-feed');
    await toWebp(png, 'family-feed', [780, 390], 80);
    await context.close();
  });
});
