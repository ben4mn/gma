// Loads every family screen in Playwright's headless shell against a static
// server on a random port, with the API mocked, and fails on any page error.
// Skips when the headless shell isn't installed (it is never downloaded here).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const webDir = fileURLToPath(new URL('..', import.meta.url));
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2', '.webmanifest': 'application/manifest+json' };
const NOW = Date.now();
const user = { id: 'u1', name: 'Sarah Lee', email: 'sarah@example.com', role: 'admin', color: '#8A3517' };
const items = [
  { id: 'i3', kind: 'photo', status: 'ready', caption: 'Meet Biscuit! He snores.', user: { id: 'u2', name: 'Lily' }, created_at: NOW - 60_000, ready_at: 1, width: 1600, height: 1200, batch_id: null },
  { id: 'i2', kind: 'video', status: 'ready', caption: 'Lily at the farm', user, created_at: NOW - 3_600_000, ready_at: 1, duration_ms: 62_000, batch_id: null, grandma_events: [{ kind: 'reaction', reaction: 'love', created_at: NOW }] },
  { id: 'i1', kind: 'photo', status: 'ready', caption: 'The fjord', user: { id: 'u3', name: 'Mike' }, created_at: NOW - 86_400_000, ready_at: 1, batch_id: 'b1' },
  { id: 'i0', kind: 'photo', status: 'ready', caption: null, user: { id: 'u3', name: 'Mike' }, created_at: NOW - 86_400_000, ready_at: 1, batch_id: 'b1' },
];
const events = [
  { id: 'e2', kind: 'voice', voice_note: { id: 'v1', duration_ms: 31_000 }, recipient: null, created_at: NOW - 1000 },
  { id: 'e1', kind: 'reaction', reaction: 'love', item: items[1], recipient: { id: 'u1', name: 'Sarah' }, created_at: NOW - 5000 },
  { id: 'e0', kind: 'preset', preset_text: 'Made my day', item: items[0], recipient: { id: 'u2', name: 'Lily' }, created_at: NOW - 90_000_000 },
];

function apiAnswer(path, signedIn) {
  if (path === '/api/me') return signedIn ? [200, { user, passkeys: 1, push: false }] : [401, { error: { code: 'unauthenticated', message: 'Please sign in.' } }];
  if (path === '/api/items') return [200, { items, next_before: null }];
  if (path === '/api/grandma-events') return [200, { events, next_before: null }];
  if (path === '/api/me/passkeys') return [200, { passkeys: [{ id: 'pk1', label: 'iPhone', created_at: NOW }] }];
  if (path === '/api/invites/tok') return [200, { valid: true, name: 'Sarah', email: 'sarah@example.com' }];
  if (path === '/api/invites/used-tok') return [200, { valid: false, name: null, email: null, emailed: false, reason: 'used' }];
  if (path === '/api/invites/gone-tok') return [200, { valid: false, name: null, email: null, emailed: false, reason: 'revoked' }];
  if (path === '/api/invites/old-tok') return [200, { valid: false, name: null, email: null, emailed: false, reason: 'expired' }];
  if (path === '/api/admin/people') return [200, { people: [user, { id: 'u9', name: 'Priya Shah', short_name: 'Priya', email: 'priya@example.com', role: 'member', status: 'pending' }], invites: [
    { id: 'inv1', name: 'Uncle Mike', email: 'mike@example.com', role: 'member', sent_at: null, expires_at: NOW + 86_400_000, used_at: null, revoked_at: null, created_at: NOW },
    { id: 'inv2', name: 'Priya Shah', email: 'priya@example.com', role: 'member', sent_at: NOW, expires_at: NOW + 86_400_000, used_at: NOW - 60_000, revoked_at: null, created_at: NOW },
  ] }];
  if (path === '/api/admin/health') {
    return [200, {
      queue_depth: 0, running: 0, failed_jobs: 1,
      recent_failures: [{ id: 'j1', kind: 'video', ref_id: 'i9', attempts: 3, error: 'The video is longer than 3 minutes.', updated_at: NOW - 3_600_000 }],
      disk_free_bytes: 800 * 1024 ** 3, disk_total_bytes: 4000 * 1024 ** 3,
      frame_last_seen: NOW - 120_000, frames: [{ id: 'd1' }], worker_last_seen: NOW - 5000,
      last_snapshot_at: NOW - 6 * 3_600_000, last_snapshot: { bytes: 2 * 1024 ** 2 },
    }];
  }
  if (path === '/api/admin/devices') return [200, { devices: [{ id: 'd1', name: 'Grandma’s frame', last_seen_at: NOW - 120_000 }] }];
  if (path === '/api/admin/presets') return [200, { presets: [{ id: 'p1', text: 'Love you', sort: 0, active: 1 }] }];
  if (path === '/api/admin/settings') return [200, { night_start: '21:00', night_end: '07:00', timezone: 'America/Chicago' }];
  if (path === '/api/admin/items') return [200, { items }];
  if (path.startsWith('/api/auth/passkey/')) return [200, { challenge: 'abc', rpId: 'localhost', allowCredentials: [], user: { id: 'dQ', name: 'x', displayName: 'x' }, rp: { name: 'x' }, pubKeyCredParams: [] }];
  return [404, { error: { code: 'not_found', message: 'Not found.' } }];
}

const patches = []; // PATCH bodies the admin screens sent
const sent = []; // POST and DELETE requests the screens sent: { method, path, body }

let server;
let origin;
let browser;
let chromium;

before(async () => {
  try { ({ chromium } = await import('playwright')); browser = await chromium.launch(); } catch { browser = null; }
  server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    if (url.pathname === '/api/events') { res.writeHead(204); return res.end(); }
    if (req.method === 'PATCH' && url.pathname.startsWith('/api/admin/people/')) {
      let raw = '';
      for await (const chunk of req) raw += chunk;
      const body = JSON.parse(raw || '{}');
      patches.push({ path: url.pathname, body });
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ user: { ...user, short_name: body.short_name } }));
    }
    if (url.pathname === '/api/invites/tok/accept' || (req.method === 'DELETE' && url.pathname.startsWith('/api/admin/invites/'))) {
      let raw = '';
      for await (const chunk of req) raw += chunk;
      sent.push({ method: req.method, path: url.pathname, body: raw ? JSON.parse(raw) : null });
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify(req.method === 'DELETE' ? { invite: { id: 'inv2', revoked_at: NOW } } : { signed_in: true, user, offer_passkey: false }));
    }
    if (url.pathname.startsWith('/api/')) {
      const [status, body] = apiAnswer(url.pathname, req.headers.cookie?.includes('signed=1'));
      res.writeHead(status, { 'content-type': 'application/json' });
      return res.end(JSON.stringify(body));
    }
    if (url.pathname.startsWith('/media/')) { res.writeHead(404); return res.end(); }
    const file = extname(url.pathname) ? normalize(join(webDir, url.pathname)) : join(webDir, 'index.html');
    if (!file.startsWith(webDir)) { res.writeHead(403); return res.end(); }
    try {
      const body = await readFile(file);
      res.writeHead(200, { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream' });
      res.end(body);
    } catch { res.writeHead(404); res.end(); }
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  origin = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await browser?.close();
  await new Promise((r) => server.close(r));
});

async function visit(path, { signedIn = true, expect }) {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, serviceWorkers: 'block' });
  if (signedIn) await context.addCookies([{ name: 'signed', value: '1', url: origin }]);
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (err) => errors.push(err.message));
  page.on('console', (msg) => { if (msg.type() === 'error' && !/Failed to load resource/.test(msg.text())) errors.push(msg.text()); });
  await page.goto(origin + path);
  await page.getByText(expect).first().waitFor({ timeout: 5000 });
  await context.close();
  assert.deepEqual(errors, [], `${path}: ${errors.join('\n')}`);
}

const screens = [
  ['/', 'Meet Biscuit! He snores.'],
  ['/from-grandma', 'a voice message'],
  ['/mine', 'From Grandma'],
  ['/upload', 'Choose photos or videos'],
  ['/you', 'Face ID and fingerprint'],
  ['/admin/people', 'Invite someone'],
  ['/admin/frame', 'Last seen 2 minutes ago'],
  ['/admin/messages', 'Messages Grandma can send'],
  ['/admin/night', 'Save night hours'],
  ['/admin/uploads', 'The fjord'],
  ['/admin/health', 'Nightly backup'],
];

for (const [path, expect] of screens) {
  test(`renders ${path}`, async (t) => {
    if (!browser) return t.skip('Playwright headless shell not installed');
    await visit(path, { expect });
  });
}

test('signed out: a private page goes to sign in; join and confirm render', async (t) => {
  if (!browser) return t.skip('Playwright headless shell not installed');
  await visit('/mine', { signedIn: false, expect: 'Welcome back' });
  await visit('/join/tok', { signedIn: false, expect: 'Welcome to Grandma’s family' });
  await visit('/confirm?t=abc', { signedIn: false, expect: 'One more tap' });
});

test('admin: Ben changes what Grandma calls someone', async (t) => {
  if (!browser) return t.skip('Playwright headless shell not installed');
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, serviceWorkers: 'block' });
  await context.addCookies([{ name: 'signed', value: '1', url: origin }]);
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (err) => errors.push(err.message));
  await page.goto(`${origin}/admin/people`);
  await page.getByText('Grandma calls them').first().waitFor({ timeout: 5000 });
  assert.equal(await page.locator('.grandma-name b').first().textContent(), 'Sarah'); // the first word, until Ben chooses
  await page.getByRole('button', { name: 'Change what Grandma calls Sarah Lee' }).click();
  await page.getByLabel('What Grandma calls them').fill('  Sally  ');
  await page.getByRole('button', { name: 'Save' }).click();
  await page.getByText('Grandma calls them Sally').waitFor({ timeout: 5000 });
  await context.close();
  assert.deepEqual(patches.at(-1), { path: '/api/admin/people/u1', body: { short_name: 'Sally' } });
  assert.deepEqual(errors, []);
});

test('join: a used, cancelled or expired invite each says what happened (F15)', async (t) => {
  if (!browser) return t.skip('Playwright headless shell not installed');
  await visit('/join/used-tok', { signedIn: false, expect: 'You’ve already joined' });
  await visit('/join/gone-tok', { signedIn: false, expect: 'This invite was cancelled' });
  await visit('/join/old-tok', { signedIn: false, expect: 'This invite has expired' });
});

const IPHONE_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Mobile/15E148 Safari/604.1';

test('join: Grandma’s name follows the name with family words kept, is sent with the accept, then Copy link on the install step (F7, F10)', async (t) => {
  if (!browser) return t.skip('Playwright headless shell not installed');
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, serviceWorkers: 'block', userAgent: IPHONE_UA, hasTouch: true, isMobile: true });
  await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (err) => errors.push(err.message));
  await page.goto(`${origin}/join/tok`);
  const short = page.getByLabel('What does Grandma call you?');
  await short.waitFor({ timeout: 5000 });
  assert.equal(await short.inputValue(), 'Sarah'); // from the invite's name
  await page.getByLabel('Your name').fill('Uncle Mike Lee');
  assert.equal(await short.inputValue(), 'Uncle Mike');
  await page.getByLabel('Your email').fill('mike@example.com');
  await page.getByRole('button', { name: 'Continue' }).click();
  await page.getByRole('heading', { name: 'Put Grandma’s family on your Home Screen' }).waitFor({ timeout: 5000 });
  assert.deepEqual(sent.find((r) => r.path === '/api/invites/tok/accept')?.body, { name: 'Uncle Mike Lee', email: 'mike@example.com', short_name: 'Uncle Mike' });
  await page.getByRole('button', { name: 'Copy link' }).click();
  await page.getByText('Copied. Now open Safari').or(page.getByText('paste it into Safari')).first().waitFor({ timeout: 5000 });
  await context.close();
  assert.deepEqual(errors, []);
});

test('join: a name they choose themselves is kept when the full name changes', async (t) => {
  if (!browser) return t.skip('Playwright headless shell not installed');
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, serviceWorkers: 'block' });
  const page = await context.newPage();
  await page.goto(`${origin}/join/tok`);
  const short = page.getByLabel('What does Grandma call you?');
  await short.fill('Mikey');
  await page.getByLabel('Your name').fill('Michael Lee');
  assert.equal(await short.inputValue(), 'Mikey');
  await context.close();
});

test('admin: an opened invite whose person hasn’t finished can be cancelled', async (t) => {
  if (!browser) return t.skip('Playwright headless shell not installed');
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, serviceWorkers: 'block' });
  await context.addCookies([{ name: 'signed', value: '1', url: origin }]);
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (err) => errors.push(err.message));
  await page.goto(`${origin}/admin/people`);
  await page.getByText('opened it, hasn’t finished signing in').waitFor({ timeout: 5000 });
  const opened = page.locator('.card-row', { hasText: 'priya@example.com' }).first();
  await opened.getByRole('button', { name: 'Cancel invite' }).click();
  await opened.getByRole('button', { name: 'Tap again to cancel' }).click();
  await page.waitForFunction(() => true);
  for (let i = 0; i < 50 && !sent.some((r) => r.method === 'DELETE'); i++) await new Promise((r) => setTimeout(r, 100));
  assert.deepEqual(sent.find((r) => r.method === 'DELETE')?.path, '/api/admin/invites/inv2');
  await context.close();
  assert.deepEqual(errors, []);
});

test('admin: the health card names the failed job and the backup', async (t) => {
  if (!browser) return t.skip('Playwright headless shell not installed');
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, serviceWorkers: 'block' });
  await context.addCookies([{ name: 'signed', value: '1', url: origin }]);
  const page = await context.newPage();
  await page.goto(`${origin}/admin/health`);
  await page.getByText('One thing needs a look. The rest is fine.').waitFor({ timeout: 5000 });
  assert.match(await page.locator('[data-health="failed"]').textContent(), /1 couldn’t be processed.*A video, 1 hour ago: The video is longer than 3 minutes\./);
  assert.match(await page.locator('[data-health="backup"]').textContent(), /\(2 MB\)/);
  await context.close();
});
