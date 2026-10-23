// The video job: ffprobe → reject anything over the limit → 720p H.264/AAC MP4
// (HDR tone-mapped, metadata and location stripped) → a poster frame → poster
// (1600 px JPEG) and thumb (480 px WebP) through sharp.

import path from 'node:path';
import { getSetting } from '../lib/settings.js';
import { VIDEO_RENDITION, VIDEO_STILLS, renderStill } from '../lib/media.js';
import { DEFAULT_VIDEO_MESSAGE, describeSeconds, permanentError } from './errors.js';
import { finishItem, loadItem, markItemFailed, throwIfAborted, withScratchDir, writeRendition } from './items.js';

// MAX_VIDEO_SECONDS is the operator's ceiling; the admin's setting may lower it.
export function maxVideoSeconds(db, config) {
  const fromSettings = Number(getSetting(db, 'max_video_seconds', config.maxVideoSeconds));
  return Number.isFinite(fromSettings) && fromSettings > 0
    ? Math.min(fromSettings, config.maxVideoSeconds)
    : config.maxVideoSeconds;
}

export function tooLongMessage(durationMs, limitSeconds) {
  return (
    `This video is ${describeSeconds(durationMs / 1000)} long, and videos can be up to ` +
    `${describeSeconds(limitSeconds)}. Please trim it and send it again.`
  );
}

export async function run(ctx, job) {
  const { db, config, storage, media, signal } = ctx;
  const item = loadItem(db, job.ref_id);
  if (!item) return;
  const input = storage.resolve(item.original_path);

  const probe = await media.probe(input, { signal });
  if (!probe.hasVideo) {
    throw permanentError('No video stream', "We couldn't find a video in this file. Please try sending it again.");
  }
  const limit = maxVideoSeconds(db, config);
  if (probe.durationMs !== null && probe.durationMs > limit * 1000) {
    throw permanentError(`Video is ${probe.durationMs} ms, over the ${limit} s limit`, tooLongMessage(probe.durationMs, limit));
  }

  const renditions = [];
  renditions.push(
    await writeRendition(storage, item.id, VIDEO_RENDITION, async (out) => {
      await media.transcodeVideo({ input, output: out, hdr: probe.hdr }, { signal });
      const result = await media.probe(out, { signal });
      return { width: result.width, height: result.height };
    }),
  );

  await withScratchDir(async (scratch) => {
    const frame = path.join(scratch, 'poster.png');
    throwIfAborted(signal);
    await media.extractPoster({ input, output: frame, durationMs: probe.durationMs, hdr: probe.hdr }, { signal });
    for (const spec of VIDEO_STILLS) {
      throwIfAborted(signal);
      renditions.push(await writeRendition(storage, item.id, spec, (out) => renderStill(frame, spec, out)));
    }
  });

  await finishItem(ctx, item.id, { width: probe.width, height: probe.height, durationMs: probe.durationMs }, renditions);
}

export function onFailed(ctx, job, err) {
  markItemFailed(ctx, job.ref_id, err?.userMessage ?? DEFAULT_VIDEO_MESSAGE);
}
