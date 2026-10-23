// How a person is named. `name` is their full name ("Michael Torres");
// `short_name` is what Grandma calls them ("Mike"), shown on the frame. It
// defaults to the first word of the name (migration 002 backfills it and fills
// it in for new rows).

export const MAX_SHORT_NAME_LENGTH = 30;

export function firstWord(name) {
  const clean = typeof name === 'string' ? name.trim().replace(/\s+/g, ' ') : '';
  return clean.split(' ')[0] ?? '';
}

// The frame's name for a person row (or any { name, short_name }).
export function shortNameOf(row) {
  const short = typeof row?.short_name === 'string' ? row.short_name.trim() : '';
  return short || firstWord(row?.name) || null;
}
