// What Grandma calls someone, worked out from their full name: the first word,
// unless the name starts with a family or title word, which stays with the name
// after it ("Uncle Mike", "Aunt Carol", "Grandpa Joe"); when the first two are
// family words, the first three ("Great Aunt Mary"). The join form prefills its
// "What does Grandma call you?" field with this, /admin shows it for a person
// with no short name, and the family app uses it for its friendly lines
// ("To Uncle Mike").
//
// The server's default is the same rule and the same words: server/src/lib/
// people.js defaultShortName() and its database trigger (migration 005).
// server/test/short-names.test.js imports this file and fails if they drift.

// Must match the server's limit (server/src/lib/people.js MAX_SHORT_NAME_LENGTH).
export const MAX_SHORT_NAME = 30;

// Lower case.
export const FAMILY_WORDS = Object.freeze(new Set([
  'aunt', 'auntie', 'aunty', 'uncle', 'cousin', 'grandma', 'grandpa', 'granny', 'grandmother', 'grandfather', 'grandad', 'granddad', 'gramps', 'gran', 'nana', 'nanna', 'papa', 'pop', 'pops', 'mama', 'mom', 'mum', 'dad',
  'great', 'great-aunt', 'great-uncle', 'great-grandma', 'great-grandpa', 'great-grandmother', 'great-grandfather',
  'big', 'little', 'sister', 'brother', 'father', 'mother', 'tia', 'tía', 'tio', 'tío',
  'mr', 'mrs', 'ms', 'miss', 'dr', 'mr.', 'mrs.', 'ms.', 'dr.',
]));

// Words are compared in ASCII lower case only, as SQLite's lower() does.
const asciiLower = (word) => word.replace(/[A-Z]/g, (c) => c.toLowerCase());
const isFamilyWord = (word) => FAMILY_WORDS.has(asciiLower(word));

// Drops leading family words until it fits, never the given name (the last word).
function fit(parts, max) {
  let picked = parts;
  while (picked.length > 1 && picked.join(' ').length > max) picked = picked.slice(1);
  return picked.join(' ').slice(0, max);
}

/** "Uncle Mike" from "Uncle Mike Lee", "Sarah" from "Sarah Lee", '' from nothing. */
export function shortNameFor(name) {
  const w = typeof name === 'string' ? name.trim().split(/\s+/).filter(Boolean) : [];
  if (!w.length) return '';
  if (w.length >= 3 && isFamilyWord(w[0]) && isFamilyWord(w[1])) return fit(w.slice(0, 3), MAX_SHORT_NAME);
  if (w.length >= 2 && isFamilyWord(w[0])) return fit(w.slice(0, 2), MAX_SHORT_NAME);
  return fit([w[0]], MAX_SHORT_NAME);
}
