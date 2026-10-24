// The image job: original photo → thumb (480 px WebP), display (1600 px JPEG)
// and large (2560 px JPEG). HEIC/HEIF is decoded by heif-dec first (the
// prebuilt sharp can't decode HEVC). sharp auto-orients and drops EXIF and GPS.

import fs from 'node:fs/promises';
import path from 'node:path';
import { IMAGE_RENDITIONS, MAX_INPUT_PIXELS, heifDeclaredPixels, isHeif, orientedSize, renderStill } from '../lib/media.js';
import { DEFAULT_PHOTO_MESSAGE, JobError, mediaIoError, permanentError } from './errors.js';

const HEIF_HEAD_BYTES = 1024 * 1024;
export const TOO_BIG_MESSAGE = "This photo is too big for us to open. Please send a smaller copy.";

// heif-dec has no size limit of its own, so the declared size is checked first.
async function assertHeifSize(file) {
  const handle = await fs.open(file, 'r');
  try {
    const { buffer, bytesRead } = await handle.read(Buffer.alloc(HEIF_HEAD_BYTES), 0, HEIF_HEAD_BYTES, 0);
    const pixels = heifDeclaredPixels(buffer.subarray(0, bytesRead));
    if (pixels !== null && pixels > MAX_INPUT_PIXELS) {
      throw permanentError(`HEIF declares ${pixels} pixels, over ${MAX_INPUT_PIXELS}`, TOO_BIG_MESSAGE);
    }
  } finally {
    await handle.close();
  }
}
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
      await assertHeifSize(original);
      await media.heifToPng({ input: original, output: source }, { signal });
    }

    let size;
    try {
      size = await orientedSize(source);
    } catch (err) {
      // The drive (or the file) went away: that is retried, not the photo's fault.
      if (mediaIoError(err)) throw err;
      await fs.access(original).catch((ioErr) => {
        throw ioErr;
      });
      throw unreadable(err);
    }

    const renditions = [];
    for (const spec of IMAGE_RENDITIONS) {
      throwIfAborted(signal);
      try {
        renditions.push(await writeRendition(storage, item.id, spec, (out) => renderStill(source, spec, out)));
      } catch (err) {
        throw err.code === 'ENOSPC' || err.code === 'EACCES' || mediaIoError(err) ? err : unreadable(err);
      }
    }
    await finishItem(ctx, item.id, size, renditions);
  });
}

// The item was deleted while the job ran: the runner then marks the job done.
export function isGone({ db }, job) {
  return !loadItem(db, job.ref_id);
}

export function onFailed(ctx, job, err) {
  markItemFailed(ctx, job.ref_id, err?.userMessage ?? DEFAULT_PHOTO_MESSAGE);
}
