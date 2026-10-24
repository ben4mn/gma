// Times as the family reads them: "10:42 am", "Yesterday", "Sunday", "0:42".
// Every function takes epoch milliseconds and an optional IANA time zone
// (the device's own zone when omitted), so tests can pin both.

const DAY_MS = 86_400_000;

function partsOf(ms, options, timeZone) {
  const fmt = new Intl.DateTimeFormat('en-US', { ...options, timeZone });
  return Object.fromEntries(fmt.formatToParts(new Date(ms)).map((p) => [p.type, p.value]));
}

/** "10:42 am" — lower-case, no leading zero on the hour. */
export function formatTime(ms, timeZone) {
  const p = partsOf(ms, { hour: 'numeric', minute: '2-digit', hour12: true }, timeZone);
  return `${p.hour}:${p.minute} ${String(p.dayPeriod).toLowerCase()}`;
}

/** The calendar day in that zone as a sortable key, "2026-10-22". */
export function dayKey(ms, timeZone) {
  const p = partsOf(ms, { year: 'numeric', month: '2-digit', day: '2-digit' }, timeZone);
  return `${p.year}-${p.month}-${p.day}`;
}

function daysBetween(fromKey, toKey) {
  const toUtc = (key) => Date.UTC(...key.split('-').map((n, i) => (i === 1 ? Number(n) - 1 : Number(n))));
  return Math.round((toUtc(toKey) - toUtc(fromKey)) / DAY_MS);
}

/** "Today", "Yesterday", a weekday within the last week, then "October 3" or "October 3, 2025". */
export function dayLabel(ms, now = Date.now(), timeZone) {
  const ago = daysBetween(dayKey(ms, timeZone), dayKey(now, timeZone));
  if (ago <= 0) return 'Today';
  if (ago === 1) return 'Yesterday';
  if (ago < 7) return partsOf(ms, { weekday: 'long' }, timeZone).weekday;
  const sameYear = dayKey(ms, timeZone).slice(0, 4) === dayKey(now, timeZone).slice(0, 4);
  const p = partsOf(ms, { month: 'long', day: 'numeric', year: 'numeric' }, timeZone);
  return sameYear ? `${p.month} ${p.day}` : `${p.month} ${p.day}, ${p.year}`;
}

/** "today", "tomorrow", a weekday within the week, else the date: for things still to come (an invite's expiry). */
export function untilLabel(ms, now = Date.now(), timeZone) {
  const ahead = daysBetween(dayKey(now, timeZone), dayKey(ms, timeZone));
  if (ahead <= 0) return 'today';
  if (ahead === 1) return 'tomorrow';
  if (ahead < 7) return partsOf(ms, { weekday: 'long' }, timeZone).weekday;
  const sameYear = dayKey(ms, timeZone).slice(0, 4) === dayKey(now, timeZone).slice(0, 4);
  const p = partsOf(ms, { month: 'long', day: 'numeric', year: 'numeric' }, timeZone);
  return sameYear ? `${p.month} ${p.day}` : `${p.month} ${p.day}, ${p.year}`;
}

/** For a post's byline: the time if it was today, else the day. */
export function whenLabel(ms, now = Date.now(), timeZone) {
  return dayKey(ms, timeZone) === dayKey(now, timeZone) ? formatTime(ms, timeZone) : dayLabel(ms, now, timeZone);
}

/** "0:42", "1:02", "1:02:03". */
export function formatDuration(ms) {
  const total = Math.max(0, Math.round((Number(ms) || 0) / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = String(total % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`;
}

/** "just now", "5 minutes ago", "3 hours ago", else the day — for "last seen". */
export function agoLabel(ms, now = Date.now(), timeZone) {
  const diff = now - ms;
  if (diff < 60_000) return 'just now';
  if (diff < 3_600_000) {
    const m = Math.floor(diff / 60_000);
    return `${m} minute${m === 1 ? '' : 's'} ago`;
  }
  if (diff < 12 * 3_600_000) {
    const h = Math.floor(diff / 3_600_000);
    return `${h} hour${h === 1 ? '' : 's'} ago`;
  }
  return `${dayLabel(ms, now, timeZone)} at ${formatTime(ms, timeZone)}`;
}
