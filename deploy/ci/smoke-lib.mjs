// Pure checks for the media smoke test (deploy/ci/smoke.mjs). No ffmpeg, no
// sharp and no database here, so `node --test 'deploy/ci/*.test.mjs'` runs them anywhere.
// Each check returns a list of problems in plain words; an empty list passes.

// ---------------------------------------------------------------------------
// MP4 boxes

// The top-level boxes of an MP4/MOV, in file order: [{ type, start, size }].
// Handles 64-bit sizes (size 1) and "to the end of the file" (size 0).
export function topLevelBoxes(buf) {
  const boxes = [];
  let at = 0;
  while (at + 8 <= buf.length) {
    let size = buf.readUInt32BE(at);
    const type = buf.toString('latin1', at + 4, at + 8);
    let header = 8;
    if (size === 1) {
      if (at + 16 > buf.length) break;
      size = Number(buf.readBigUInt64BE(at + 8));
      header = 16;
    } else if (size === 0) {
      size = buf.length - at;
    }
    if (size < header) break; // a broken box: stop rather than loop
    boxes.push({ type, start: at, size });
    at += size;
  }
  return boxes;
}

// "faststart": the index (moov) comes before the media (mdat), so a phone can
// start playing before the whole file has arrived.
export function checkFaststart(buf) {
  const types = topLevelBoxes(buf).map((b) => b.type);
  const moov = types.indexOf('moov');
  const mdat = types.indexOf('mdat');
  if (moov === -1) return ['there is no moov box'];
  if (mdat === -1) return ['there is no mdat box'];
  return moov < mdat ? [] : [`moov comes after mdat (boxes: ${types.join(', ')})`];
}

// ---------------------------------------------------------------------------
// ffprobe JSON

// Tags that say where or when something was filmed. Matched case-insensitively,
// as a substring, on every tag key in format.tags and each stream's tags.
export const PRIVATE_TAG_PATTERNS = Object.freeze(['location', 'iso6709', 'creation_time', 'date', 'gps', 'make', 'model']);

export function privateTags(probe) {
  const found = [];
  const scan = (where, tags) => {
    for (const key of Object.keys(tags ?? {})) {
      if (PRIVATE_TAG_PATTERNS.some((p) => key.toLowerCase().includes(p))) found.push(`${where}: ${key}=${tags[key]}`);
    }
  };
  scan('format', probe?.format?.tags);
  for (const [i, s] of (probe?.streams ?? []).entries()) scan(`stream ${i} (${s.codec_type})`, s.tags);
  return found;
}

const videoStream = (probe) => (probe?.streams ?? []).find((s) => s.codec_type === 'video' && s.disposition?.attached_pic !== 1);
const audioStream = (probe) => (probe?.streams ?? []).find((s) => s.codec_type === 'audio');

// The contract's video rendition: H.264 High, yuv420p, 8-bit, 720 on the short
// side (or smaller when the source was), AAC audio, SDR BT.709, nothing private.
export function checkVideoRendition(probe, { shortSide = 720, expectAudio = true } = {}) {
  const problems = [];
  const v = videoStream(probe);
  if (!v) return ['there is no video stream'];
  if (v.codec_name !== 'h264') problems.push(`video codec is ${v.codec_name}, not h264`);
  if (v.profile !== 'High') problems.push(`H.264 profile is ${v.profile}, not High`);
  if (v.pix_fmt !== 'yuv420p') problems.push(`pixel format is ${v.pix_fmt}, not yuv420p`);
  const bits = Number(v.bits_per_raw_sample);
  if (bits !== 8) problems.push(`bit depth is ${v.bits_per_raw_sample}, not 8`);
  const short = Math.min(v.width, v.height);
  if (short !== shortSide) problems.push(`short side is ${short} (${v.width}x${v.height}), not ${shortSide}`);
  if (v.width % 2 || v.height % 2) problems.push(`size ${v.width}x${v.height} is not even`);
  for (const key of ['color_transfer', 'color_primaries']) {
    if (v[key] && !['bt709', 'unknown'].includes(v[key])) problems.push(`${key} is ${v[key]}, not bt709 (HDR was not tone-mapped)`);
  }
  const a = audioStream(probe);
  if (expectAudio && !a) problems.push('there is no audio stream');
  if (a && a.codec_name !== 'aac') problems.push(`audio codec is ${a.codec_name}, not aac`);
  problems.push(...privateTags(probe).map((t) => `private metadata kept: ${t}`));
  return problems;
}

// The contract's voice rendition: AAC, mono, in an MP4 (M4A) container.
export function checkVoiceRendition(probe) {
  const problems = [];
  const streams = probe?.streams ?? [];
  if (streams.some((s) => s.codec_type === 'video')) problems.push('the voice note has a video stream');
  const a = audioStream(probe);
  if (!a) return [...problems, 'there is no audio stream'];
  if (a.codec_name !== 'aac') problems.push(`audio codec is ${a.codec_name}, not aac`);
  if (a.channels !== 1) problems.push(`audio has ${a.channels} channels, not 1 (mono)`);
  if (!String(probe?.format?.format_name ?? '').includes('mp4')) problems.push(`container is ${probe?.format?.format_name}, not mp4`);
  problems.push(...privateTags(probe).map((t) => `private metadata kept: ${t}`));
  return problems;
}

// A still (poster, thumb, display, large) as ffprobe sees it.
export function checkStill(probe, { codec, maxSide }) {
  const v = videoStream(probe);
  if (!v) return ['ffprobe found no image'];
  const problems = [];
  if (v.codec_name !== codec) problems.push(`codec is ${v.codec_name}, not ${codec}`);
  if (Math.max(v.width, v.height) > maxSide) problems.push(`${v.width}x${v.height} is larger than ${maxSide} px`);
  return problems;
}

// ---------------------------------------------------------------------------
// Image metadata (from sharp's metadata())

// No EXIF at all (so no GPS), no XMP and no IPTC on a rendition.
export function checkStillMetadata(meta) {
  const problems = [];
  if (meta?.exif) problems.push(`EXIF kept (${meta.exif.length} bytes)`);
  if (meta?.xmp) problems.push('XMP kept');
  if (meta?.iptc) problems.push('IPTC kept');
  return problems;
}

// True when an EXIF block carries a GPS IFD pointer (tag 0x8825), in either
// byte order. Used to prove the fixtures really had a location to strip.
export function exifHasGps(exif) {
  if (!exif || exif.length < 8) return false;
  const le = Buffer.from([0x25, 0x88]);
  const be = Buffer.from([0x88, 0x25]);
  const tiff = exif.indexOf('II*\0') !== -1 ? le : be;
  return exif.indexOf(tiff) !== -1;
}

// ---------------------------------------------------------------------------
// Reporting

export function formatSeconds(ms) {
  return `${(ms / 1000).toFixed(1)} s`;
}

// [{ name, problems }] → { ok, lines } for the log.
export function summarise(results) {
  const lines = [];
  let ok = true;
  for (const { name, problems } of results) {
    if (problems.length) {
      ok = false;
      lines.push(`FAIL ${name}`);
      for (const p of problems) lines.push(`     - ${p}`);
    } else {
      lines.push(`ok   ${name}`);
    }
  }
  return { ok, lines };
}
