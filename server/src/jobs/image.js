// The image job: original photo → thumb (480 px WebP), display (1600 px JPEG)
// and large (2560 px JPEG). HEIC/HEIF is decoded by heif-dec first (the
// prebuilt sharp can't decode HEVC). sharp auto-orients and drops EXIF and GPS.

import path from 'node:path';
import { IMAGE_RENDITIONS, isHeif, orientedSize, renderStill } from '../lib/media.js';
import { DEFAULT_PHOTO_MESSAGE, JobError } from './errors.js';
import { finishItem, loadItem, markItemFailed, throwIfAborted, withScratchDir, writeRendition } from './items.js';

// sharp could not read the pixels: trying again will not help.
function unreadable(err) {
  return new JobError(`sharp could not read the photo: ${err.message}`, {
    userMessage: DEFAULT_PHOTO_MESSAGE,
    permanent: true,
    cause: err,
  });
}

export async function run(ctx, job) {
  const { db, storage, media, signal } = ctx;
  const item = loadItem(db, job.ref_id);
  if (!item) return; // deleted before we got to it
  const original = storage.resolve(item.original_path);

  await withScratchDir(async (scratch) => {
    let source = original;
    if (isHeif(item.original_mime)) {
      source = path.join(scratch, 'decoded.png');
      await media.heifToPng({ input: original, output: source }, { signal });
    }

    let size;
    try {
      size = await orientedSize(source);
    } catch (err) {
      throw unreadable(err);
    }

    const renditions = [];
    for (const spec of IMAGE_RENDITIONS) {
      throwIfAborted(signal);
      try {
        renditions.push(await writeRendition(storage, item.id, spec, (out) => renderStill(source, spec, out)));
      } catch (err) {
        throw err.code === 'ENOSPC' || err.code === 'EACCES' ? err : unreadable(err);
      }
    }
    await finishItem(ctx, item.id, size, renditions);
  });
}

export function onFailed(ctx, job, err) {
  markItemFailed(ctx, job.ref_id, err?.userMessage ?? DEFAULT_PHOTO_MESSAGE);
}
