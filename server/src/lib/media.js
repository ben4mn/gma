// The media tools the worker drives: binary detection, a spawn wrapper, ffprobe
// parsing, the exact ffmpeg argument lists from the contract, file sniffing and
// sharp stills. Everything that spawns goes through one `exec` function, so the
// tests can swap it for a fake on machines without ffmpeg or heif-dec.

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';

// ---------------------------------------------------------------------------
// Renditions (ARCHITECTURE.md, "Media pipeline")

export const IMAGE_RENDITIONS = Object.freeze([
  { name: 'thumb', size: 480, format: 'webp', quality: 72, ext: 'webp', mime: 'image/webp' },
  { name: 'display', size: 1600, format: 'jpeg', quality: 82, ext: 'jpg', mime: 'image/jpeg' },
  { name: 'large', size: 2560, format: 'jpeg', quality: 85, ext: 'jpg', mime: 'image/jpeg' },
]);

export const VIDEO_STILLS = Object.freeze([
  { name: 'poster', size: 1600, format: 'jpeg', quality: 82, ext: 'jpg', mime: 'image/jpeg' },
  { name: 'thumb', size: 480, format: 'webp', quality: 72, ext: 'webp', mime: 'image/webp' },
]);

export const VIDEO_RENDITION = Object.freeze({ name: 'video', ext: 'mp4', mime: 'video/mp4' });
export const AUDIO_RENDITION = Object.freeze({ name: 'audio', ext: 'm4a', mime: 'audio/mp4' });

// The server trims voice notes here even though the recorder stops at 60 s.
export const VOICE_TRIM_SECONDS = 65;

// ---------------------------------------------------------------------------
// Errors

// A tool exited badly. `stderr` keeps only the tail; it never reaches a person.
export class MediaToolError extends Error {
  constructor(message, { tool, code = null, stderr = '', timedOut = false } = {}) {
    super(message);
    this.name = 'MediaToolError';
    this.tool = tool;
    this.exitCode = code;
    this.stderr = stderr;
    this.timedOut = timedOut; // the tool ran past its time limit (trying again would too)
  }
}

export class MissingBinaryError extends Error {
  constructor(name) {
    super(`${name} is not installed on this server`);
    this.name = 'MissingBinaryError';
    this.binary = name;
  }
}

// ---------------------------------------------------------------------------
// Binaries

// The executable called `name` on PATH, or null.
export function findBinary(name, { envPath = process.env.PATH ?? '' } = {}) {
  for (const dir of envPath.split(path.delimiter)) {
    if (!dir) continue;
    const candidate = path.join(dir, name);
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      if (fs.statSync(candidate).isFile()) return candidate;
    } catch {
      // not here
    }
  }
  return null;
}

export const BINARIES = Object.freeze({ ffmpeg: 'ffmpeg', ffprobe: 'ffprobe', heifDec: 'heif-dec' });

// { ffmpeg, ffprobe, heifDec } → absolute path or null. Tests use it to skip.
export function detectBinaries(options) {
  return Object.fromEntries(Object.entries(BINARIES).map(([key, name]) => [key, findBinary(name, options)]));
}

// ---------------------------------------------------------------------------
// Spawning

const STDERR_TAIL = 4000;
const STDOUT_CAP = 8 * 1024 * 1024;

// Runs `file args…` without a shell. Resolves { stdout, stderr } on exit 0;
// rejects with MediaToolError otherwise. `signal` aborts (SIGKILL), and
// `timeoutMs` bounds a stuck tool.
export function exec(file, args, { signal, timeoutMs = 30 * 60 * 1000 } = {}) {
  return new Promise((resolve, reject) => {
    const tool = path.basename(file);
    if (signal?.aborted) {
      reject(new MediaToolError(`${tool} was cancelled`, { tool }));
      return;
    }
    const child = spawn(file, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let settled = false;

    const finish = (err, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      if (err) reject(err);
      else resolve(value);
    };
    const onAbort = () => {
      child.kill('SIGKILL');
      finish(new MediaToolError(`${tool} was cancelled`, { tool, stderr }));
    };
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish(
        new MediaToolError(`${tool} took longer than ${Math.round(timeoutMs / 1000)} s`, { tool, stderr, timedOut: true }),
      );
    }, timeoutMs);
    timer.unref?.();
    signal?.addEventListener('abort', onAbort, { once: true });

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      if (stdout.length < STDOUT_CAP) stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr = (stderr + chunk).slice(-STDERR_TAIL);
    });
    child.on('error', (err) => {
      if (err.code === 'ENOENT') finish(new MissingBinaryError(tool));
      else finish(new MediaToolError(`${tool} could not start: ${err.message}`, { tool }));
    });
    child.on('close', (code) => {
      if (code === 0) finish(null, { stdout, stderr });
      else finish(new MediaToolError(`${tool} exited with code ${code}`, { tool, code, stderr }));
    });
  });
}

// ---------------------------------------------------------------------------
// ffprobe

const HDR_TRANSFERS = new Set(['arib-std-b67', 'smpte2084']);

export function isHdr(colorTransfer) {
  return HDR_TRANSFERS.has(colorTransfer);
}

function finiteNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function rotationOf(stream) {
  for (const side of stream.side_data_list ?? []) {
    const r = finiteNumber(side.rotation);
    if (r !== null) return r;
  }
  return finiteNumber(stream.tags?.rotate) ?? 0;
}

// ffprobe's -show_format -show_streams JSON → the few facts the pipeline needs.
// width/height are as displayed (swapped for a ±90° rotation).
export function parseProbe(json) {
  const data = typeof json === 'string' ? JSON.parse(json) : json;
  const streams = Array.isArray(data?.streams) ? data.streams : [];
  const video = streams.find((s) => s.codec_type === 'video' && s.disposition?.attached_pic !== 1) ?? null;
  const audio = streams.find((s) => s.codec_type === 'audio') ?? null;
  const seconds = finiteNumber(data?.format?.duration) ?? finiteNumber(video?.duration) ?? finiteNumber(audio?.duration);
  const rotation = video ? rotationOf(video) : 0;
  const quarterTurn = Math.abs(Math.round(rotation / 90)) % 2 === 1;
  const codedWidth = finiteNumber(video?.width);
  const codedHeight = finiteNumber(video?.height);
  return {
    durationMs: seconds === null ? null : Math.round(seconds * 1000),
    hasVideo: Boolean(video),
    hasAudio: Boolean(audio),
    width: quarterTurn ? codedHeight : codedWidth,
    height: quarterTurn ? codedWidth : codedHeight,
    rotation,
    colorTransfer: video?.color_transfer ?? null,
    hdr: isHdr(video?.color_transfer),
  };
}

// ---------------------------------------------------------------------------
// ffmpeg argument lists (kept pure so they can be checked without ffmpeg)

// zscale tone map for HLG/PQ phone video → SDR BT.709.
export const TONE_MAP_FILTER =
  'zscale=t=linear:npl=100,format=gbrpf32le,zscale=p=bt709,tonemap=tonemap=hable:desat=0,zscale=t=bt709:m=bt709:r=tv';

// 720 on the SHORT side, never upscaled: a landscape 1920x1080 becomes 1280x720,
// a portrait 1080x1920 becomes 720x1280, a 480x854 clip stays as it is. ffmpeg
// has already applied the rotation, so iw/ih are as displayed. The short side is
// kept even (yuv420p needs it); -2 keeps the aspect ratio with an even long side.
export const SCALE_FILTER =
  "scale=w='if(gte(iw,ih),-2,min(720,trunc(iw/2)*2))':h='if(gte(iw,ih),min(720,trunc(ih/2)*2),-2)'";

export function videoFilter({ hdr }) {
  const scale = `${SCALE_FILTER},format=yuv420p`;
  return hdr ? `${TONE_MAP_FILTER},${scale}` : scale;
}

// One video must not take every core of the shared server.
export const FFMPEG_THREADS = '2';

const QUIET = ['-hide_banner', '-nostdin', '-loglevel', 'error', '-y'];

// The transcode never takes more than the limit plus a second, whatever the
// container claims its length is (a stream with no duration, or a short header
// over a long sample table): the job then probes the result against the limit.
export function buildVideoArgs({ input, output, hdr = false, maxSeconds = null }) {
  const cap = Number.isFinite(maxSeconds) && maxSeconds > 0 ? ['-t', String(Math.ceil(maxSeconds) + 1)] : [];
  return [
    ...QUIET,
    '-filter_threads', FFMPEG_THREADS,
    '-threads', FFMPEG_THREADS,
    '-i', input,
    '-map', '0:v:0',
    '-map', '0:a:0?',
    '-map_metadata', '-1',
    '-map_chapters', '-1',
    '-vf', videoFilter({ hdr }),
    '-c:v', 'libx264',
    '-threads', FFMPEG_THREADS,
    '-profile:v', 'high',
    '-preset', 'veryfast',
    '-crf', '23',
    '-maxrate', '3M',
    '-bufsize', '6M',
    '-c:a', 'aac',
    '-b:a', '128k',
    '-ac', '2',
    ...cap,
    '-movflags', '+faststart',
    '-f', 'mp4',
    output,
  ];
}

// A transcode's time limit: generous for a real video of `maxSeconds` on two
// threads, but bounded, so one crafted file can't hold the video queue.
export function videoTimeoutMs(maxSeconds) {
  const seconds = Number.isFinite(maxSeconds) && maxSeconds > 0 ? maxSeconds : 180;
  return Math.min(30 * 60_000, Math.max(5 * 60_000, seconds * 4 * 1000));
}

// The poster frame: 1 s in, or the first frame of a clip shorter than that.
export function posterSeconds(durationMs) {
  return durationMs !== null && durationMs !== undefined && durationMs < 1000 ? 0 : 1;
}

export function buildPosterArgs({ input, output, durationMs, hdr = false }) {
  const filter = hdr ? `${TONE_MAP_FILTER},format=rgb24` : 'format=rgb24';
  return [
    ...QUIET,
    '-filter_threads', FFMPEG_THREADS,
    '-threads', FFMPEG_THREADS,
    '-ss', String(posterSeconds(durationMs)),
    '-i', input,
    '-map', '0:v:0',
    '-frames:v', '1',
    '-map_metadata', '-1',
    '-vf', filter,
    '-c:v', 'png',
    '-f', 'image2',
    output,
  ];
}

export function buildVoiceArgs({ input, output }) {
  return [
    ...QUIET,
    '-i', input,
    '-vn',
    '-t', String(VOICE_TRIM_SECONDS),
    '-map_metadata', '-1',
    '-ac', '1',
    '-c:a', 'aac',
    '-b:a', '64k',
    '-movflags', '+faststart',
    '-f', 'mp4',
    output,
  ];
}

export function buildProbeArgs(input) {
  return ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', input];
}

// ---------------------------------------------------------------------------
// The tool belt the jobs use. `exec` and `which` are injectable for tests.

export function createMediaTools({ exec: run = exec, which = findBinary } = {}) {
  const cache = new Map();
  function binary(name) {
    if (!cache.has(name)) cache.set(name, which(name));
    const found = cache.get(name);
    if (!found) throw new MissingBinaryError(name);
    return found;
  }

  return {
    binary,
    has(name) {
      try {
        binary(name);
        return true;
      } catch {
        return false;
      }
    },
    async probe(input, { signal } = {}) {
      const { stdout } = await run(binary('ffprobe'), buildProbeArgs(input), { signal, timeoutMs: 60_000 });
      try {
        return parseProbe(stdout);
      } catch {
        throw new MediaToolError('ffprobe printed something that was not JSON', { tool: 'ffprobe' });
      }
    },
    async transcodeVideo({ input, output, hdr, maxSeconds = null }, { signal } = {}) {
      await run(binary('ffmpeg'), buildVideoArgs({ input, output, hdr, maxSeconds }), {
        signal,
        timeoutMs: videoTimeoutMs(maxSeconds),
      });
    },
    async extractPoster({ input, output, durationMs, hdr }, { signal } = {}) {
      await run(binary('ffmpeg'), buildPosterArgs({ input, output, durationMs, hdr }), { signal, timeoutMs: 120_000 });
    },
    async transcodeVoice({ input, output }, { signal } = {}) {
      await run(binary('ffmpeg'), buildVoiceArgs({ input, output }), { signal, timeoutMs: 120_000 });
    },
    // heif-dec writes the primary image; its output format follows the extension.
    async heifToPng({ input, output }, { signal } = {}) {
      await run(binary('heif-dec'), [input, output], { signal, timeoutMs: 120_000 });
    },
  };
}

// ---------------------------------------------------------------------------
// Sniffing: what a file really is, from its first bytes (never the client's word)

const HEIF_BRANDS = new Set(['heic', 'heix', 'hevc', 'hevx', 'heim', 'heis', 'hevm', 'hevs', 'mif1', 'msf1']);
const AVIF_BRANDS = new Set(['avif', 'avis']);
const QUICKTIME_ATOMS = new Set(['moov', 'mdat', 'wide', 'free', 'skip', 'pnot']);

// → { kind: 'photo'|'video'|'audio', mime, ext } or null.
export function detectType(buf) {
  if (!buf || buf.length < 12) return null;
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return { kind: 'photo', mime: 'image/jpeg', ext: 'jpg' };
  if (buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return { kind: 'photo', mime: 'image/png', ext: 'png' };
  }
  if (buf.toString('latin1', 0, 4) === 'RIFF' && buf.toString('latin1', 8, 12) === 'WEBP') {
    return { kind: 'photo', mime: 'image/webp', ext: 'webp' };
  }
  if (buf.readUInt32BE(0) === 0x1a45dfa3) return { kind: 'video', mime: 'video/webm', ext: 'webm' };
  if (buf.toString('latin1', 0, 4) === 'OggS') return { kind: 'audio', mime: 'audio/ogg', ext: 'ogg' };

  const box = buf.toString('latin1', 4, 8);
  if (box === 'ftyp') {
    const size = Math.min(buf.readUInt32BE(0), buf.length);
    const brands = [buf.toString('latin1', 8, 12)];
    for (let at = 16; at + 4 <= size; at += 4) brands.push(buf.toString('latin1', at, at + 4));
    const major = brands[0];
    if (brands.some((b) => AVIF_BRANDS.has(b)) && AVIF_BRANDS.has(major)) return { kind: 'photo', mime: 'image/avif', ext: 'avif' };
    if (HEIF_BRANDS.has(major)) {
      return major === 'mif1' || major === 'msf1'
        ? { kind: 'photo', mime: 'image/heif', ext: 'heif' }
        : { kind: 'photo', mime: 'image/heic', ext: 'heic' };
    }
    if (major === 'qt  ') return { kind: 'video', mime: 'video/quicktime', ext: 'mov' };
    if (major === 'M4A ' || major === 'M4B ') return { kind: 'audio', mime: 'audio/mp4', ext: 'm4a' };
    if (major === 'M4V ' || major === 'M4VH' || major === 'M4VP') return { kind: 'video', mime: 'video/x-m4v', ext: 'm4v' };
    if (major.startsWith('3g')) return { kind: 'video', mime: 'video/3gpp', ext: '3gp' };
    return { kind: 'video', mime: 'video/mp4', ext: 'mp4' };
  }
  if (QUICKTIME_ATOMS.has(box)) return { kind: 'video', mime: 'video/quicktime', ext: 'mov' };
  return null;
}

export async function sniffFile(filePath) {
  const handle = await fsp.open(filePath, 'r');
  try {
    const buf = Buffer.alloc(64);
    const { bytesRead } = await handle.read(buf, 0, buf.length, 0);
    return detectType(buf.subarray(0, bytesRead));
  } finally {
    await handle.close();
  }
}

export function isHeif(mime) {
  return mime === 'image/heic' || mime === 'image/heif';
}

// ---------------------------------------------------------------------------
// sharp stills

// The largest image we decode: a 48 MP phone photo fits with room to spare,
// while a crafted "decompression bomb" is refused before it eats the memory.
export const MAX_INPUT_PIXELS = 120_000_000;
const SHARP_INPUT = { failOn: 'error', limitInputPixels: MAX_INPUT_PIXELS };

// The pixel count of the largest image a HEIF/HEIC file declares (its `ispe`
// boxes, which sit in the `meta` box at the front of the file), or null when
// none is found in `head`. Checked before heif-dec, which has no limit of its own.
export function heifDeclaredPixels(head) {
  let largest = null;
  for (let at = head.indexOf('ispe'); at !== -1 && at + 16 <= head.length; at = head.indexOf('ispe', at + 4)) {
    const width = head.readUInt32BE(at + 8);
    const height = head.readUInt32BE(at + 12);
    const pixels = width * height;
    if (largest === null || pixels > largest) largest = pixels;
  }
  return largest;
}

// The image's size once EXIF orientation is applied.
export async function orientedSize(input) {
  const meta = await sharp(input, SHARP_INPUT).metadata();
  const swap = (meta.orientation ?? 1) >= 5;
  return { width: swap ? meta.height : meta.width, height: swap ? meta.width : meta.height };
}

// Writes one still rendition to `output`: auto-oriented, fit inside size×size,
// never enlarged, metadata (EXIF, GPS) dropped (sharp's default).
export async function renderStill(input, spec, output) {
  let pipeline = sharp(input, SHARP_INPUT)
    .autoOrient()
    .resize({ width: spec.size, height: spec.size, fit: 'inside', withoutEnlargement: true });
  pipeline =
    spec.format === 'webp'
      ? pipeline.webp({ quality: spec.quality })
      : pipeline.jpeg({ quality: spec.quality, mozjpeg: true });
  const info = await pipeline.toFile(output);
  return { width: info.width, height: info.height, bytes: info.size };
}
