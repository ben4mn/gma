// How a person is named. `name` is their full name ("Michael Torres");
// `short_name` is what Grandma calls them ("Mike", "Uncle Mike"), shown on the
// frame. It can be set on joining or in /admin; otherwise it defaults to the
// first word of the name, unless the name starts with a family or title word:
// then that word and the next ("Uncle Mike", "Aunt Carol"), or the first three
// when the first two are family words ("Great Aunt Mary"). One rule in three
// places, kept equal by test/short-names.test.js: this file, the database's
// default (migrations/005_kinship_short_names.sql) and the join form's prefill
// (web/shared/names.js).

export const MAX_SHORT_NAME_LENGTH = 30;

// Lower case. The same list as migrations/005 and web/shared/names.js.
export const FAMILY_WORDS = Object.freeze(new Set([
  'aunt', 'auntie', 'aunty', 'uncle', 'cousin', 'grandma', 'grandpa', 'granny', 'grandmother', 'grandfather', 'grandad', 'granddad', 'gramps', 'gran', 'nana', 'nanna', 'papa', 'pop', 'pops', 'mama', 'mom', 'mum', 'dad',
  'great', 'great-aunt', 'great-uncle', 'great-grandma', 'great-grandpa', 'great-grandmother', 'great-grandfather',
  'big', 'little', 'sister', 'brother', 'father', 'mother', 'tia', 'tía', 'tio', 'tío',
  'mr', 'mrs', 'ms', 'miss', 'dr', 'mr.', 'mrs.', 'ms.', 'dr.',
]));

function words(name) {
  const clean = typeof name === 'string' ? name.trim().replace(/\s+/g, ' ') : '';
  return clean ? clean.split(' ') : [];
}

export function firstWord(name) {
  return words(name)[0] ?? '';
}

// Words are compared in ASCII lower case only, as SQLite's lower() does.
const asciiLower = (word) => word.replace(/[A-Z]/g, (c) => c.toLowerCase());
const isFamilyWord = (word) => FAMILY_WORDS.has(asciiLower(word));

// Drops leading family words until it fits, never the given name (the last word).
function fit(parts, max = MAX_SHORT_NAME_LENGTH) {
  let picked = parts;
  while (picked.length > 1 && picked.join(' ').length > max) picked = picked.slice(1);
  return picked.join(' ').slice(0, max);
}

// "Uncle Mike Torres" → "Uncle Mike"; "Great Aunt Mary Lee" → "Great Aunt Mary"; "Sarah Lee" → "Sarah".
export function defaultShortName(name) {
  const w = words(name);
  if (!w.length) return '';
  if (w.length >= 3 && isFamilyWord(w[0]) && isFamilyWord(w[1])) return fit(w.slice(0, 3));
  if (w.length >= 2 && isFamilyWord(w[0])) return fit(w.slice(0, 2));
  return fit([w[0]]);
}

// The frame's name for a person row (or any { name, short_name }).
export function shortNameOf(row) {
  const short = typeof row?.short_name === 'string' ? row.short_name.trim() : '';
  return short || defaultShortName(row?.name) || null;
}
