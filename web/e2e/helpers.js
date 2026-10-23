// Shared pieces for the end-to-end specs: the environment run.sh exports, the
// sign-in codes the console mail transport prints into the app log, a CDP
// virtual authenticator, and the accessibility audit ported from design/tools/shoot.py.
import fs from 'node:fs/promises';
import path from 'node:path';
import { expect } from '@playwright/test';

export const BASE = process.env.E2E_BASE_URL ?? 'http://localhost:8787';
export const APP_LOG = process.env.E2E_APP_LOG;
export const FRAME_URL = process.env.E2E_FRAME_URL;
export const SHOTS = process.env.E2E_SHOTS ?? path.resolve(import.meta.dirname, 'shots');
export const ADMIN_EMAIL = process.env.E2E_ADMIN_EMAIL ?? 'ben@example.com';

export const FAMILY_VIEWPORT = { width: 390, height: 844 };
export const GRANDMA_VIEWPORT = { width: 1280, height: 800 };

if (!APP_LOG || !FRAME_URL) {
  throw new Error('Run the end-to-end tests through web/e2e/run.sh (E2E_APP_LOG and E2E_FRAME_URL are missing).');
}

/** The newest sign-in code mailed to `email` after `since` bytes of the log. */
export async function codeFor(email, { since = 0, timeout = 10_000 } = {}) {
  const deadline = Date.now() + timeout;
  const marker = `--- email to ${email} ---`;
  while (Date.now() < deadline) {
    const log = (await fs.readFile(APP_LOG, 'utf8')).slice(since);
    const at = log.lastIndexOf(marker);
    if (at !== -1) {
      const match = log.slice(at).match(/Subject: (\d{6}) is your code/);
      if (match) return match[1];
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`No sign-in code for ${email} in the app log`);
}

export async function logSize() {
  return (await fs.stat(APP_LOG)).size;
}

/** A platform authenticator with user verification, like Face ID on a phone. */
export async function addVirtualAuthenticator(page) {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('WebAuthn.enable');
  const { authenticatorId } = await cdp.send('WebAuthn.addVirtualAuthenticator', {
    options: {
      protocol: 'ctap2',
      transport: 'internal',
      hasResidentKey: true,
      hasUserVerification: true,
      isUserVerified: true,
      automaticPresenceSimulation: true,
    },
  });
  return { cdp, authenticatorId };
}

/** Collects every request that would leave the app's origin. */
export function watchExternal(page) {
  const external = [];
  const origin = new URL(BASE).origin;
  page.on('request', (req) => {
    const url = req.url();
    if (url.startsWith('data:') || url.startsWith('blob:')) return;
    if (new URL(url).origin !== origin) external.push(url);
  });
  return external;
}

/** Signs in on the family app with an email code. Returns after the home tabs show. */
export async function signInWithCode(page, email) {
  await page.goto('/signin');
  const since = await logSize();
  await page.getByLabel('Your email').fill(email);
  await page.getByRole('button', { name: 'Email me a code' }).click();
  await expect(page.getByRole('heading', { name: 'Check your email' })).toBeVisible();
  await page.getByLabel('Your code').fill(await codeFor(email, { since }));
}

/** After a code sign-in: waits for the passkey offer or the feed, and declines the offer. */
export async function skipPasskeyOffer(page) {
  const offer = page.getByRole('heading', { name: 'Use Face ID or your fingerprint next time' });
  const feed = page.getByRole('heading', { name: 'Family', exact: true });
  await expect(offer.or(feed)).toBeVisible();
  if (await offer.isVisible()) await page.getByRole('button', { name: 'Not now' }).click();
}

export async function shoot(page, name) {
  await fs.mkdir(SHOTS, { recursive: true });
  await page.screenshot({ path: path.join(SHOTS, `${name}.png`) });
}

// The audit from design/tools/shoot.py, at this build's thresholds:
// Grandma: targets ≥ 80 px, text ≥ 22 px, contrast ≥ 7:1 (4.5:1 large), no scroll,
// a visible Home ≥ 80 px, no autoplay. Family: targets ≥ 44, text ≥ 13, 4.5:1 (3:1 large).
export const AUDIT_JS = (surface) => {
  const G = surface === 'grandma';
  const MIN_TAP = G ? 80 : 44, MIN_FONT = G ? 22 : 13;
  const NORMAL = G ? 7 : 4.5, LARGE = G ? 4.5 : 3;
  const cv = document.createElement('canvas'); cv.width = cv.height = 1;
  const cx = cv.getContext('2d', { willReadFrequently: true });
  const rgba = (c) => {
    cx.clearRect(0, 0, 1, 1); cx.fillStyle = '#000'; cx.fillStyle = c; cx.fillRect(0, 0, 1, 1);
    const d = cx.getImageData(0, 0, 1, 1).data; return [d[0], d[1], d[2], d[3] / 255];
  };
  const over = (top, bot) => { const a = top[3]; return [0, 1, 2].map((i) => top[i] * a + bot[i] * (1 - a)).concat([1]); };
  const lum = (c) => { const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
    return 0.2126 * f(c[0]) + 0.7152 * f(c[1]) + 0.0722 * f(c[2]); };
  const ratio = (a, b) => { const x = lum(a), y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };
  const visible = (el) => {
    const r = el.getBoundingClientRect(); if (r.width < 1 || r.height < 1) return false;
    if (r.bottom < 0 || r.right < 0 || r.top > innerHeight || r.left > innerWidth) return false;
    for (let e = el; e; e = e.parentElement) { const s = getComputedStyle(e);
      if (s.display === 'none' || s.visibility === 'hidden' || parseFloat(s.opacity) === 0) return false; }
    return true;
  };
  const label = (el) => (el.getAttribute('aria-label') || el.innerText || el.tagName).trim().replace(/\s+/g, ' ').slice(0, 50);
  const issues = [];
  const se = document.scrollingElement;
  if (G && (se.scrollHeight > innerHeight + 1 || se.scrollWidth > innerWidth + 1))
    issues.push({ kind: 'scroll', msg: `page scrolls: ${se.scrollWidth}x${se.scrollHeight} > viewport` });
  const taps = [...document.querySelectorAll('button, a[href], [role=button], [data-tap], input, select, textarea')].filter(visible);
  for (const el of taps) { const r = el.getBoundingClientRect();
    if (r.width < MIN_TAP - 0.5 || r.height < MIN_TAP - 0.5)
      issues.push({ kind: 'tap', msg: `"${label(el)}" is ${Math.round(r.width)}x${Math.round(r.height)} (< ${MIN_TAP})` }); }
  if (G) { const homes = [...document.querySelectorAll('[data-home]')].filter(visible);
    if (!homes.length) issues.push({ kind: 'home', msg: 'no visible [data-home] button' });
    for (const el of homes) { const r = el.getBoundingClientRect();
      if (r.width < 80 || r.height < 80) issues.push({ kind: 'home', msg: `home button ${Math.round(r.width)}x${Math.round(r.height)}` }); } }
  for (const m of document.querySelectorAll('video, audio'))
    if (m.autoplay || m.hasAttribute('autoplay')) issues.push({ kind: 'autoplay', msg: `${m.tagName} has autoplay` });
  const tw = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  const seen = new Set(); let n; let measured = 0;
  while ((n = tw.nextNode())) {
    if (!n.nodeValue.trim()) continue; const el = n.parentElement;
    if (!el || seen.has(el) || !visible(el)) continue; seen.add(el);
    const s = getComputedStyle(el); const fs = parseFloat(s.fontSize); const bold = parseInt(s.fontWeight, 10) >= 700;
    const txt = n.nodeValue.trim().slice(0, 40);
    if (fs < MIN_FONT - 0.1) issues.push({ kind: 'font', msg: `"${txt}" is ${fs}px (< ${MIN_FONT})` });
    const r = el.getBoundingClientRect();
    const x = Math.min(Math.max(r.left + r.width / 2, 0), innerWidth - 1), y = Math.min(Math.max(r.top + r.height / 2, 0), innerHeight - 1);
    let layers = [], img = null;
    for (const e of document.elementsFromPoint(x, y)) { const es = getComputedStyle(e);
      if (['IMG', 'VIDEO', 'CANVAS', 'PICTURE', 'IFRAME'].includes(e.tagName)) { img = e.tagName.toLowerCase(); break; }
      if (es.backgroundImage && es.backgroundImage !== 'none') { img = 'background'; break; }
      const bg = rgba(es.backgroundColor); if (bg[3] > 0) { layers.push(bg); if (bg[3] >= 0.999) break; } }
    if (img) continue; // text over a photo is judged by eye in the screenshots (scrims)
    const fg = rgba(s.color); const large = fs >= 24 || (bold && fs >= 18.66); const need = large ? LARGE : NORMAL;
    let bg = [255, 255, 255, 1]; for (let i = layers.length - 1; i >= 0; i--) bg = over(layers[i], bg);
    const c = ratio(over(fg, bg), bg); measured++;
    if (c < need) issues.push({ kind: 'contrast', msg: `"${txt}" ${c.toFixed(2)}:1 (< ${need}) fg ${s.color} on ${bg.slice(0, 3).join(',')}` });
  }
  return { issues, measured, taps: taps.length };
};

export async function audit(page, surface) {
  await page.evaluate(() => document.fonts.ready.then(() => true));
  return page.evaluate(AUDIT_JS, surface);
}

/** State-changing requests need the app's Origin (the server's CSRF rule). */
export const ORIGIN_HEADERS = { origin: new URL(BASE).origin };

/**
 * Moves night hours so the frame is awake (or asleep) right now, whatever the
 * clock says. `request` is a signed-in admin's page.request.
 */
export async function setNight(request, { asleep }) {
  const hour = Number(new Intl.DateTimeFormat('en-US', { hour: 'numeric', hourCycle: 'h23', timeZone: 'America/Chicago' }).format(new Date()));
  const at = (h) => `${String(((h % 24) + 24) % 24).padStart(2, '0')}:00`;
  const data = asleep
    ? { night_start: at(hour - 1), night_end: at(hour + 2), timezone: 'America/Chicago' }
    : { night_start: at(hour + 3), night_end: at(hour + 4), timezone: 'America/Chicago' };
  const res = await request.put('/api/admin/settings', { data, headers: ORIGIN_HEADERS });
  if (!res.ok()) throw new Error(`Setting night hours failed: ${res.status()} ${await res.text()}`);
}
