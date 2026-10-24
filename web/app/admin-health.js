// Turns GET /api/admin/health into the calm lines of the admin Health card:
// the nightly backup, work waiting or failed, the photo drive and its upload
// limits, Grandma's frame and the worker. Pure, so the wording is tested.
import { agoLabel, dayLabel, formatTime } from '../shared/time.js';

const MIN = 60_000;
const HOUR = 60 * MIN;
const BACKUP_LATE_MS = 36 * HOUR; // it runs every night at 3:15
const FRAME_QUIET_MS = HOUR;
const WORKER_QUIET_MS = 2 * MIN; // it checks in every 15 s
const KB = 1024;
const KINDS = { image: 'A photo', video: 'A video', voice: 'A voice message' };

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const trim0 = (s) => s.replace(/\.0$/, '');

/** "12.5 MB", "2.3 GB", "812 GB", "3.9 TB". */
export function formatBytes(bytes) {
  const b = num(bytes) ?? 0;
  const gb = b / KB ** 3;
  if (gb >= KB) return `${trim0((gb / KB).toFixed(1))} TB`;
  if (gb >= 10) return `${Math.round(gb)} GB`;
  if (gb >= 1) return `${trim0(gb.toFixed(1))} GB`;
  return `${trim0((b / KB ** 2).toFixed(1))} MB`;
}

function clock(ms, now, timeZone) {
  return `${dayLabel(ms, now, timeZone)} at ${formatTime(ms, timeZone)}`;
}

function backupLine(h, now, timeZone) {
  const at = num(h.last_snapshot_at) ?? num(h.last_snapshot?.at);
  if (at == null) return { key: 'backup', label: 'Nightly backup', value: 'No backup yet. The first one runs tonight at 3:15.', warn: true };
  const size = num(h.last_snapshot?.bytes);
  const late = now - at > BACKUP_LATE_MS;
  const value = late
    ? `The last one was ${clock(at, now, timeZone)}. It should run every night.`
    : `${clock(at, now, timeZone)}${size ? ` (${formatBytes(size)})` : ''}`;
  return { key: 'backup', label: 'Nightly backup', value, warn: late };
}

function failedLine(h, now, timeZone) {
  const n = num(h.failed_jobs) ?? 0;
  const details = (Array.isArray(h.recent_failures) ? h.recent_failures : []).map((f) => {
    const what = KINDS[f.kind] ?? 'Something';
    const when = num(f.updated_at) != null ? `, ${agoLabel(f.updated_at, now, timeZone)}` : '';
    return `${what}${when}${f.error ? `: ${f.error}` : ''}`;
  });
  return {
    key: 'failed',
    label: 'Failed',
    value: n ? `${n} couldn’t be processed` : 'None',
    warn: n > 0,
    details: n ? details : [],
  };
}

function driveLine(h) {
  const free = num(h.disk_free_bytes);
  const total = num(h.disk_total_bytes);
  const floor = num(h.upload_limits?.min_free_bytes) ?? 0;
  if (free == null) return { key: 'drive', label: 'Photo drive', value: 'We couldn’t read how much space is free.', warn: true };
  const value = `${formatBytes(free)} free${total ? ` of ${formatBytes(total)}` : ''}${floor > 0 ? `. New uploads stop below ${formatBytes(floor)}.` : ''}`;
  const warn = (floor > 0 && free < floor * 2) || (total ? free / total < 0.05 : false);
  return { key: 'drive', label: 'Photo drive', value, warn };
}

function budgetLine(h) {
  const files = num(h.upload_limits?.files_per_day);
  const bytes = num(h.upload_limits?.bytes_per_day);
  if (files == null && bytes == null) return null;
  const parts = [files != null ? `${files} photos and videos` : null, bytes != null ? formatBytes(bytes) : null].filter(Boolean);
  return { key: 'budget', label: 'Upload limits', value: `Up to ${parts.join(', or ')}, per person a day`, warn: false };
}

function frameLine(h, now, timeZone) {
  const seen = num(h.frame_last_seen);
  const frames = Array.isArray(h.frames) ? h.frames.length : 0;
  if (seen == null) {
    return frames
      ? { key: 'frame', label: 'Grandma’s frame', value: 'Paired, but not seen yet', warn: true }
      : { key: 'frame', label: 'Grandma’s frame', value: 'No frame is paired yet', warn: false };
  }
  const quiet = now - seen > FRAME_QUIET_MS;
  return {
    key: 'frame',
    label: 'Grandma’s frame',
    value: quiet ? `Last seen ${agoLabel(seen, now, timeZone)}. It may be off or offline.` : `Seen ${agoLabel(seen, now, timeZone)}`,
    warn: quiet,
  };
}

function workerLine(h, now, timeZone) {
  const seen = num(h.worker_last_seen);
  if (seen == null) return { key: 'worker', label: 'Background worker', value: 'It hasn’t checked in yet.', warn: true };
  const quiet = now - seen > WORKER_QUIET_MS;
  return {
    key: 'worker',
    label: 'Background worker',
    value: quiet ? `It last checked in ${agoLabel(seen, now, timeZone)}. New photos wait until it’s back.` : 'Working',
    warn: quiet,
  };
}

/** → [{key, label, value, warn, details?}] in the order the card shows them. */
export function healthLines(health, { now = Date.now(), timeZone } = {}) {
  const h = health && typeof health === 'object' ? health : {};
  const waiting = num(h.queue_depth) ?? 0;
  return [
    backupLine(h, now, timeZone),
    { key: 'queue', label: 'Getting ready', value: waiting ? `${waiting} getting ready` : 'Nothing waiting', warn: false },
    failedLine(h, now, timeZone),
    driveLine(h),
    budgetLine(h),
    frameLine(h, now, timeZone),
    workerLine(h, now, timeZone),
  ].filter(Boolean);
}
