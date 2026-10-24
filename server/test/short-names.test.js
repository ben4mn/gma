// F7: what Grandma calls someone by default is one rule in three places: the
// server (lib/people.js defaultShortName), the database's trigger (migration
// 005, for every row inserted or renamed without a short name) and the join
// form's prefill (web/shared/names.js, shipped in the image at /app/web). This
// test fails if any of them drifts from the others.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { defaultShortName, FAMILY_WORDS, MAX_SHORT_NAME_LENGTH } from '../src/lib/people.js';
import { shortNameFor, FAMILY_WORDS as WEB_FAMILY_WORDS, MAX_SHORT_NAME } from '../../web/shared/names.js';
import { makeTestApp, makeUser } from './helpers/index.js';

const NAMES = [
  'Sarah Lee', 'Mike', '  Ruth   Ann Alvarez ', 'Uncle Mike', 'Uncle Mike Torres', 'aunt Carol', 'AUNT CAROL LEE',
  'Grandpa Joe', 'Grandpa', 'Great Aunt Mary', 'great aunt Mary Smith', 'Great Aunt', 'Great-Grandma Rose',
  'Great Great Grandma Wilhelmina', 'Cousin Dee', 'Tía Rosa', 'Tio Juan Perez', 'Dr. Ruth Lee', 'Mrs Jones',
  'Big Mike', 'Little Joe Smith', 'Nana', 'Gramps Walter', 'Sister Mary Clare', 'Mom',
  'Great Aunt Wilhelmina-Bartholomew Smith', 'Uncle Bartholomew-Wilhelmina-Smithson', 'Bartholomew-Wilhelmina-Smithsonian Lee',
  'Grandmother',
];

test('the server and the join form use the same words and the same limit', () => {
  assert.deepEqual([...FAMILY_WORDS].sort(), [...WEB_FAMILY_WORDS].sort());
  assert.equal(MAX_SHORT_NAME_LENGTH, MAX_SHORT_NAME);
});

test('the database trigger lists the same words as the code', () => {
  const sql = fs.readFileSync(new URL('../src/db/migrations/005_kinship_short_names.sql', import.meta.url), 'utf8');
  const lists = [...sql.matchAll(/lower\(w1\) IN \(([^)]*)\)/g)].map((m) => m[1]);
  assert.ok(lists.length >= 4, 'the rule appears in the update and both triggers');
  for (const list of lists) {
    const words = [...list.matchAll(/'([^']*)'/g)].map((m) => m[1]).sort();
    assert.deepEqual(words, [...FAMILY_WORDS].sort());
  }
});

test('server, join form and database give the same short name for every name', async (t) => {
  const ctx = await makeTestApp();
  t.after(ctx.cleanup);
  const shortOf = (id) => ctx.db.prepare('SELECT short_name FROM users WHERE id = ?').get(id).short_name;
  const renamed = makeUser(ctx.db, { name: 'Placeholder' });
  for (const name of NAMES) {
    const server = defaultShortName(name);
    assert.equal(shortNameFor(name), server, `join form vs server for "${name}"`);
    const row = makeUser(ctx.db, { name });
    assert.equal(shortOf(row.id), server, `insert trigger vs server for "${name}"`);
    ctx.db.prepare('UPDATE users SET name = ? WHERE id = ?').run(name, renamed.id);
    assert.equal(shortOf(renamed.id), server, `rename trigger vs server for "${name}"`);
  }
});

test('the rule itself', () => {
  assert.equal(defaultShortName('Uncle Mike Torres'), 'Uncle Mike');
  assert.equal(defaultShortName('Great Aunt Mary Lee'), 'Great Aunt Mary');
  assert.equal(defaultShortName('Sarah Lee'), 'Sarah');
  assert.equal(defaultShortName('Great Aunt Wilhelmina-Bartholomew Smith'), 'Aunt Wilhelmina-Bartholomew');
  assert.equal(defaultShortName(''), '');
});
