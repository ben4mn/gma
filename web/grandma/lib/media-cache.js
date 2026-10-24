// Pure helpers for the frame's service worker: which requests are media, which
// cached files to evict, and how to answer a video Range request from a cached file.

export const LIMITS = Object.freeze({ maxImages: 300, maxVideoBytes: 500 * 1024 * 1024 });

/** 'image' for display/poster renditions, 'video' for the video rendition, else null. */
export function mediaKind(pathname) {
  const m = /^\/media\/([^/]+)\/(display|poster|video)$/.exec(pathname);
  if (!m || m[1] === 'voice') return null;
  return m[2] === 'video' ? 'video' : 'image';
}

/**
 * URLs to delete so at most `maxImages` images (least recently used go first)
 * and at most `maxVideoBytes` of video stay cached.
 * index: [{url, kind, bytes, used_at}]
 */
export function planEvictions(index, limits = LIMITS) {
  const byUse = (a, b) => b.used_at - a.used_at; // most recent first
  const images = index.filter((e) => e.kind === 'image').sort(byUse);
  const videos = index.filter((e) => e.kind === 'video').sort(byUse);
  const evict = images.slice(limits.maxImages).map((e) => e.url);
  let total = 0;
  for (const v of videos) {
    total += v.bytes || 0;
    if (total > limits.maxVideoBytes) evict.push(v.url);
  }
  return evict;
}

/** Parse "bytes=start-end" against a file of `size` bytes; null when it can't be served. */
export function parseRange(header, size) {
  const m = /^bytes=(\d*)-(\d*)$/.exec(String(header ?? '').trim());
  if (!m || (m[1] === '' && m[2] === '')) return null;
  let start;
  let end;
  if (m[1] === '') { // a suffix: the last N bytes
    start = Math.max(0, size - Number(m[2]));
    end = size - 1;
  } else {
    start = Number(m[1]);
    end = m[2] === '' ? size - 1 : Math.min(Number(m[2]), size - 1);
  }
  if (start > end || start >= size) return null;
  return { start, end };
}

/** A 206 answer for `rangeHeader` built from a complete cached Response. */
export async function rangeResponse(full, rangeHeader) {
  const blob = await full.blob();
  const range = parseRange(rangeHeader, blob.size);
  const type = full.headers.get('Content-Type') || 'video/mp4';
  if (!range) {
    return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${blob.size}` } });
  }
  const body = blob.slice(range.start, range.end + 1, type);
  return new Response(body, {
    status: 206,
    headers: {
      'Content-Type': type,
      'Content-Length': String(body.size),
      'Content-Range': `bytes ${range.start}-${range.end}/${blob.size}`,
      'Accept-Ranges': 'bytes',
    },
  });
}
