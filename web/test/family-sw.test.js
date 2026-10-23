import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const webDir = fileURLToPath(new URL('..', import.meta.url));
const source = readFileSync(join(webDir, 'sw.js'), 'utf8');

// Run the worker's top level with a stand-in `self` that records its listeners.
function loadWorker() {
  const listeners = {};
  const shown = [];
  const self = {
    location: { origin: 'https://gma.4mn.org' },
    addEventListener: (type, fn) => { listeners[type] = fn; },
    registration: { showNotification: (title, options) => { shown.push({ title, options }); return Promise.resolve(); } },
  };
  const exports = new Function('self', `${source}\nreturn { SHELL, notificationFromPayload };`)(self);
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
