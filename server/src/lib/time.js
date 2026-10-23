// Time helpers. Every stored time is integer milliseconds since the epoch (UTC).

export const SECOND = 1000;
export const MINUTE = 60 * SECOND;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;

let clock = () => Date.now();

export function now() {
  return clock();
}

// Tests can pin the clock: setClock(() => 1_700_000_000_000). Call setClock() to reset.
export function setClock(fn) {
  clock = typeof fn === 'function' ? fn : () => Date.now();
}

// "HH:MM" on a 24-hour clock for `ms` in an IANA time zone.
export function clockInZone(ms, timeZone) {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone,
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(new Date(ms));
  const hour = parts.find((p) => p.type === 'hour').value;
  const minute = parts.find((p) => p.type === 'minute').value;
  return `${hour}:${minute}`;
}

function toMinutes(hhmm) {
  const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(String(hhmm));
  if (!match) throw new RangeError(`Expected a time like "21:00", got "${hhmm}"`);
  return Number(match[1]) * 60 + Number(match[2]);
}

export function isValidClockTime(hhmm) {
  return /^([01]\d|2[0-3]):([0-5]\d)$/.test(String(hhmm));
}

// True when the wall-clock time `hhmm` falls in [start, end). Windows may
// cross midnight ("21:00" to "07:00"). A window whose start equals its end is empty.
export function inWindow(hhmm, start, end) {
  const t = toMinutes(hhmm);
  const s = toMinutes(start);
  const e = toMinutes(end);
  if (s === e) return false;
  return s < e ? t >= s && t < e : t >= s || t < e;
}

// Night mode for the frame: { night_start, night_end, timezone } come from settings.
export function isNight(ms, { night_start, night_end, timezone }) {
  return inWindow(clockInZone(ms, timezone), night_start, night_end);
}
