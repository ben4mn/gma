import { test } from 'node:test';
import assert from 'node:assert/strict';
import { healthLines, formatBytes } from '../app/admin-health.js';

const NOW = Date.UTC(2026, 9, 22, 15, 0); // 10:00 am in Chicago
const TZ = 'America/Chicago';
const GB = 1024 ** 3;
const MIN = 60_000;
const HOUR = 60 * MIN;

const healthy = {
  queue_depth: 0, running: 0, queue: { image: 0, video: 0, voice: 0 },
  failed_jobs: 0, recent_failures: [],
  disk_free_bytes: 800 * GB, disk_total_bytes: 4000 * GB,
  frame_last_seen: NOW - 2 * MIN, frames: [{ id: 'd1', name: 'Grandma’s frame', last_seen_at: NOW - 2 * MIN }],
  worker_last_seen: NOW - 10_000,
  last_snapshot_at: NOW - 7 * HOUR, last_snapshot: { day: '2026-10-22', file: 'backups/gma-2026-10-22.sqlite', bytes: 12.5 * 1024 ** 2, at: NOW - 7 * HOUR },
  now: NOW,
};

const byKey = (lines) => Object.fromEntries(lines.map((l) => [l.key, l]));

test('a healthy server reads calmly, with nothing flagged', () => {
  const lines = byKey(healthLines(healthy, { now: NOW, timeZone: TZ }));
  assert.equal(lines.backup.value, 'Today at 3:00 am (12.5 MB)');
  assert.equal(lines.queue.value, 'Nothing waiting');
  assert.equal(lines.failed.value, 'None');
  assert.equal(lines.drive.value, '800 GB free of 3.9 TB');
  assert.equal(lines.frame.value, 'Seen 2 minutes ago');
  assert.equal(lines.worker.value, 'Working');
  assert.deepEqual(Object.values(lines).filter((l) => l.warn), []);
});

test('no backup yet, an old backup and failed jobs are flagged', () => {
  assert.equal(byKey(healthLines({ ...healthy, last_snapshot_at: null, last_snapshot: null }, { now: NOW, timeZone: TZ })).backup.warn, true);
  const old = byKey(healthLines({ ...healthy, last_snapshot_at: NOW - 3 * 24 * HOUR, last_snapshot: null }, { now: NOW, timeZone: TZ }));
  assert.equal(old.backup.warn, true);
  assert.match(old.backup.value, /every night/);
  const failed = byKey(healthLines({
    ...healthy,
    failed_jobs: 2,
    recent_failures: [
      { id: 'j2', kind: 'video', ref_id: 'i9', attempts: 3, error: 'ffmpeg exited 1', updated_at: NOW - 2 * HOUR },
      { id: 'j1', kind: 'image', ref_id: 'i8', attempts: 1, error: null, updated_at: NOW - 5 * MIN },
    ],
  }, { now: NOW, timeZone: TZ })).failed;
  assert.equal(failed.warn, true);
  assert.equal(failed.value, '2 couldn’t be processed');
  assert.deepEqual(failed.details, ['A video, 2 hours ago: ffmpeg exited 1', 'A photo, 5 minutes ago']);
});

test('upload budgets and the free-space floor show when the server sends them', () => {
  const withLimits = { ...healthy, upload_limits: { files_per_day: 200, bytes_per_day: 10 * GB, min_free_bytes: 50 * GB } };
  const lines = byKey(healthLines(withLimits, { now: NOW, timeZone: TZ }));
  assert.equal(lines.budget.value, 'Up to 200 photos and videos, or 10 GB, per person a day');
  assert.equal(lines.drive.value, '800 GB free of 3.9 TB. New uploads stop below 50 GB.');
  assert.equal(lines.drive.warn, false);
  const low = byKey(healthLines({ ...withLimits, disk_free_bytes: 70 * GB }, { now: NOW, timeZone: TZ }));
  assert.equal(low.drive.warn, true);
  assert.equal(byKey(healthLines(healthy, { now: NOW, timeZone: TZ })).budget, undefined);
});

test('a quiet frame, a stopped worker and work in progress', () => {
  const lines = byKey(healthLines({
    ...healthy, queue_depth: 3, running: 1, frame_last_seen: NOW - 5 * HOUR, worker_last_seen: NOW - 10 * MIN,
  }, { now: NOW, timeZone: TZ }));
  assert.equal(lines.queue.value, '3 getting ready');
  assert.equal(lines.frame.warn, true);
  assert.match(lines.frame.value, /5 hours ago/);
  assert.equal(lines.worker.warn, true);
  assert.match(lines.worker.value, /10 minutes ago/);
  const unpaired = byKey(healthLines({ ...healthy, frame_last_seen: null, frames: [] }, { now: NOW, timeZone: TZ }));
  assert.equal(unpaired.frame.value, 'No frame is paired yet');
});

test('missing numbers never print "null" or "NaN"', () => {
  const text = JSON.stringify(healthLines({}, { now: NOW, timeZone: TZ }));
  assert.doesNotMatch(text, /null|NaN|undefined/);
});

test('formatBytes', () => {
  assert.equal(formatBytes(12.5 * 1024 ** 2), '12.5 MB');
  assert.equal(formatBytes(50 * GB), '50 GB');
  assert.equal(formatBytes(812.34 * GB), '812 GB');
  assert.equal(formatBytes(4000 * GB), '3.9 TB');
  assert.equal(formatBytes(2.25 * GB), '2.3 GB');
});
