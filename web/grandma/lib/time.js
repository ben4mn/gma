// Time on Grandma's frame: always in the family's timezone (settings.timezone),
// never the Pi's, so the clock and night hours agree with what Ben set in admin.

const DAY_MS = 86_400_000;
const formatters = new Map();

function formatter(timeZone, options) {
  const key = timeZone + JSON.stringify(options);
  let f = formatters.get(key);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', { timeZone, ...options });
    formatters.set(key, f);
  }
  return f;
}

/** The wall-clock parts of `ms` in `timeZone`. */
export function zonedParts(ms, timeZone) {
  const parts = formatter(timeZone, {
    year: 'numeric', month: 'numeric', day: 'numeric',
    hour: 'numeric', minute: 'numeric', hourCycle: 'h23',
  }).formatToParts(new Date(ms));
  const get = (type) => Number(parts.find((p) => p.type === type)?.value);
  return {
    year: get('year'), month: get('month'), day: get('day'),
    hour: get('hour') % 24, minute: get('minute'),
  };
}

/** "10:42 am" */
export function formatTime(ms, timeZone) {
  const { hour, minute } = zonedParts(ms, timeZone);
  const h12 = hour % 12 === 0 ? 12 : hour % 12;
  return `${h12}:${String(minute).padStart(2, '0')} ${hour < 12 ? 'am' : 'pm'}`;
}

/** "Tuesday, October 21" */
export function formatDate(ms, timeZone) {
  return formatter(timeZone, { weekday: 'long', month: 'long', day: 'numeric' }).format(new Date(ms));
}

/** "21:00" → 1260 minutes after midnight; null when it isn't a time. */
export function parseHm(text) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(text ?? '').trim());
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) return null;
  return h * 60 + min;
}

/** Is minute-of-day `now` inside [start, end)? The window may cross midnight. */
export function isNightMinutes(now, start, end) {
  if (start == null || end == null || start === end) return false;
  return start < end ? now >= start && now < end : now >= start || now < end;
}

/** Night on the frame, from settings {night_start, night_end, timezone}. */
export function isNightAt(ms, settings) {
  const { hour, minute } = zonedParts(ms, settings.timezone);
  return isNightMinutes(hour * 60 + minute, parseHm(settings.night_start), parseHm(settings.night_end));
}

function dayNumber(ms, timeZone) {
  const { year, month, day } = zonedParts(ms, timeZone);
  return Math.round(Date.UTC(year, month - 1, day) / DAY_MS);
}

/** When something arrived, the way you'd say it: "This morning", "Yesterday", "Saturday", "October 3". */
export function whenLabel(ms, nowMs, timeZone) {
  const days = dayNumber(nowMs, timeZone) - dayNumber(ms, timeZone);
  if (days <= 0) {
    const { hour } = zonedParts(ms, timeZone);
    if (hour < 12) return 'This morning';
    if (hour < 17) return 'This afternoon';
    return 'This evening';
  }
  if (days === 1) return 'Yesterday';
  if (days < 7) return formatter(timeZone, { weekday: 'long' }).format(new Date(ms));
  const sameYear = zonedParts(ms, timeZone).year === zonedParts(nowMs, timeZone).year;
  return formatter(timeZone, sameYear
    ? { month: 'long', day: 'numeric' }
    : { month: 'long', day: 'numeric', year: 'numeric' }).format(new Date(ms));
}

/** The recorder's countdown: "1:00", "0:42", "0:00". Rounds up, so it never shows 0:00 early. */
export function formatCountdown(ms) {
  const s = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/** A video's length in words for the play plate: "1 minute", "45 seconds". */
export function durationWords(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return '';
  const s = Math.round(ms / 1000);
  if (s < 10) return 'a few seconds';
  if (s < 55) return `${Math.round(s / 5) * 5} seconds`;
  const min = Math.max(1, Math.round(s / 60));
  return min === 1 ? '1 minute' : `${min} minutes`;
}
