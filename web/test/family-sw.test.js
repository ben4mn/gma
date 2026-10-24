import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const webDir = fileURLToPath(new URL('..', import.meta.url));
const source = readFileSync(join(webDir, 'sw.js'), 'utf8');

// Run the worker's top level with a stand-in `self` that records its listeners.
// `fetch` and `caches` stand in for the worker's globals when a test needs them.
function loadWorker({ fetch, caches } = {}) {
  const listeners = {};
  const shown = [];
  const self = {
    location: { origin: 'https://gma.4mn.org' },
    addEventListener: (type, fn) => { listeners[type] = fn; },
    registration: { showNotification: (title, options) => { shown.push({ title, options }); return Promise.resolve(); } },
  };
  const exports = new Function('self', 'fetch', 'caches', `${source}\nreturn { SHELL, notificationFromPayload };`)(self, fetch, caches);
  return { ...exports, listeners, shown };
}

function walk(dir) {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    return statSync(full).isDirectory() ? walk(full) : [full];
  });
}

test('the worker is a classic script (no import/export)', () => {
  assert.doesNotMatch(source, /^\s*(import|export)\s/m);
});

test('every precached file exists, and every app module is precached', () => {
  const { SHELL } = loadWorker();
  for (const url of SHELL) assert.ok(existsSync(join(webDir, url)), `missing ${url}`);
  const modules = [...walk(join(webDir, 'app')), ...walk(join(webDir, 'shared'))]
    .filter((f) => /\.(js|css)$/.test(f))
    .map((f) => `/${relative(webDir, f).split(sep).join('/')}`);
  for (const m of modules) assert.ok(SHELL.includes(m), `${m} is not precached`);
});

test('a push always shows a notification with the declarative fields', async () => {
  const { listeners, shown } = loadWorker();
  let waited;
  listeners.push({
    data: { json: () => ({ web_push: 8030, notification: { title: 'Grandma loved your photo', body: '❤️ Love', navigate: 'https://gma.4mn.org/from-grandma#e-1', tag: 'grandma-9' } }) },
    waitUntil: (p) => { waited = p; },
  });
  await waited;
  assert.equal(shown[0].title, 'Grandma loved your photo');
  assert.equal(shown[0].options.tag, 'grandma-9');
  assert.equal(shown[0].options.data.navigate, 'https://gma.4mn.org/from-grandma#e-1');
});

test('a push with an unreadable payload still shows something', async () => {
  const { listeners, shown } = loadWorker();
  let waited;
  listeners.push({ data: { json: () => { throw new Error('not json'); }, text: () => 'hello' }, waitUntil: (p) => { waited = p; } });
  await waited;
  assert.equal(shown[0].title, 'Grandma’s family');
  assert.equal(shown[0].options.body, 'hello');
});

test('the family worker leaves every /grandma address to the frame’s own worker', () => {
  const { listeners } = loadWorker();
  const answered = (path, mode) => {
    let responded = false;
    listeners.fetch({
      request: { method: 'GET', url: `https://gma.4mn.org${path}`, mode, headers: new Headers() },
      respondWith: (p) => { responded = true; Promise.resolve(p).catch(() => {}); },
    });
    return responded;
  };
  for (const path of ['/grandma', '/grandma?device=abc', '/grandma/', '/grandma/?fixture=1']) {
    assert.equal(answered(path, 'navigate'), false, path);
  }
  for (const path of ['/grandma/sw.js', '/grandma/grandma.js', '/grandma/grandma.css']) {
    assert.equal(answered(path, 'no-cors'), false, path);
  }
  assert.equal(answered('/mine', 'navigate'), true, 'a family page is still the family worker’s');
});

test('a page is kept for offline launches only when the server marks it as the shell, never the landing page', async () => {
  const stored = new Map();
  const cache = {
    put: async (key, res) => { stored.set(key, await res.text()); },
    match: async (key) => (stored.has(key) ? new Response(stored.get(key), { headers: { 'content-type': 'text/html' } }) : undefined),
  };
  const caches = { open: async () => cache, match: async () => undefined };
  let next;
  const { listeners } = loadWorker({ fetch: async () => next, caches });
  const navigate = async (path, body, headers = {}) => {
    next = new Response(body, { headers: { 'content-type': 'text/html; charset=utf-8', ...headers } });
    let answer;
    listeners.fetch({
      request: { method: 'GET', url: `https://gma.4mn.org${path}`, mode: 'navigate', headers: new Headers() },
      respondWith: (p) => { answer = p; },
    });
    const res = await answer;
    await new Promise((resolve) => setTimeout(resolve, 0)); // the worker doesn't wait for its cache write
    return res;
  };

  await navigate('/', '<landing>');
  assert.equal(stored.has('/__shell'), false, 'the landing page (signed out at /) is not the shell');
  await navigate('/signin', '<shell>', { 'x-gma-page': 'shell' });
  assert.equal(stored.get('/__shell'), '<shell>');
  await navigate('/', '<landing>');
  await navigate('/landing.html', '<landing>');
  assert.equal(stored.get('/__shell'), '<shell>', 'a later visit to the landing page keeps the real shell');
});
