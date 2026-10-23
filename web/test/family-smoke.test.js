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
  if (path === '/api/admin/people') return [200, { people: [user], invites: [] }];
  if (path === '/api/admin/health') return [200, { queue_depth: 0, failed_jobs: 0 }];
  if (path === '/api/admin/devices') return [200, { devices: [{ id: 'd1', name: 'Grandma’s frame', last_seen_at: NOW - 120_000 }] }];
  if (path === '/api/admin/presets') return [200, { presets: [{ id: 'p1', text: 'Love you', sort: 0, active: 1 }] }];
  if (path === '/api/admin/settings') return [200, { night_start: '21:00', night_end: '07:00', timezone: 'America/Chicago' }];
  if (path === '/api/admin/items') return [200, { items }];
  if (path.startsWith('/api/auth/passkey/')) return [200, { challenge: 'abc', rpId: 'localhost', allowCredentials: [], user: { id: 'dQ', name: 'x', displayName: 'x' }, rp: { name: 'x' }, pubKeyCredParams: [] }];
  return [404, { error: { code: 'not_found', message: 'Not found.' } }];
}

let server;
let origin;
let browser;
let chromium;

before(async () => {
  try { ({ chromium } = await import('playwright')); browser = await chromium.launch(); } catch { browser = null; }
  server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    if (url.pathname === '/api/events') { res.writeHead(204); return res.end(); }
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
