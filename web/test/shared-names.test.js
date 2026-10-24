import { test } from 'node:test';
import assert from 'node:assert/strict';
import { shortNameFor, MAX_SHORT_NAME } from '../shared/names.js';

test('the first word for an ordinary name', () => {
  assert.equal(shortNameFor('Sarah Lee'), 'Sarah');
  assert.equal(shortNameFor('  Mike  '), 'Mike');
  assert.equal(shortNameFor('Ruth Ann Alvarez'), 'Ruth');
});

test('a family word stays with the name after it', () => {
  assert.equal(shortNameFor('Uncle Mike'), 'Uncle Mike');
  assert.equal(shortNameFor('Aunt Carol Lee'), 'Aunt Carol');
  assert.equal(shortNameFor('Grandpa Joe'), 'Grandpa Joe');
  assert.equal(shortNameFor('great aunt Mary Smith'), 'great aunt Mary');
  assert.equal(shortNameFor('Great-Grandma Rose'), 'Great-Grandma Rose');
  assert.equal(shortNameFor('Cousin Dee'), 'Cousin Dee');
  assert.equal(shortNameFor('Tía Rosa'), 'Tía Rosa');
});

test('only family words, nothing, and very long names', () => {
  assert.equal(shortNameFor('Grandpa'), 'Grandpa');
  assert.equal(shortNameFor(''), '');
  assert.equal(shortNameFor(null), '');
  // At most two family words lead; a default over 30 characters drops them, never the given name.
  assert.equal(shortNameFor('Great Great Grandma Wilhelmina'), 'Great Great Grandma');
  const long = shortNameFor('Great Aunt Wilhelmina-Bartholomew Smith');
  assert.ok(long.length <= MAX_SHORT_NAME, long);
  assert.equal(long, 'Aunt Wilhelmina-Bartholomew');
  assert.equal(shortNameFor('Uncle Bartholomew-Wilhelmina-Smithson'), 'Bartholomew-Wilhelmina-Smithso');
});

test('titles and the server-only family words count too (one list with the server)', () => {
  assert.equal(shortNameFor('Dr. Ruth Lee'), 'Dr. Ruth');
  assert.equal(shortNameFor('Big Mike Torres'), 'Big Mike');
  assert.equal(shortNameFor('Gramps'), 'Gramps');
  assert.equal(shortNameFor('Gran Ellen'), 'Gran Ellen');
});
