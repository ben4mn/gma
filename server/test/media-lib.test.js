import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {
  buildPosterArgs,
  buildVideoArgs,
  buildVoiceArgs,
  createMediaTools,
  detectBinaries,
  detectType,
  exec,
  findBinary,
  MediaToolError,
  MissingBinaryError,
  parseProbe,
  posterSeconds,
  sniffFile,
} from '../src/lib/media.js';
import { describeSeconds } from '../src/jobs/errors.js';
import { makeTempDir } from './helpers/index.js';
import { makeJpeg, makePng } from './fixtures/images.js';

const BIN = detectBinaries();

test('parseProbe reads duration, size, rotation, HDR and audio', () => {
  const p = parseProbe({
    format: { duration: '61.5' },
    streams: [
      { codec_type: 'video', width: 3840, height: 2160, color_transfer: 'smpte2084', side_data_list: [{ rotation: 90 }] },
      { codec_type: 'audio' },
    ],
  });
  assert.deepEqual(p, { durationMs: 61500, hasVideo: true, hasAudio: true, width: 2160, height: 3840, rotation: 90, colorTransfer: 'smpte2084', hdr: true });

  const old = parseProbe(JSON.stringify({ format: {}, streams: [{ codec_type: 'video', width: 640, height: 480, duration: '2', tags: { rotate: '180' } }] }));
  assert.deepEqual([old.durationMs, old.width, old.height, old.rotation, old.hasAudio, old.hdr], [2000, 640, 480, 180, false, false]);

  const voice = parseProbe({ format: { duration: '4.2' }, streams: [{ codec_type: 'audio' }] });
  assert.deepEqual([voice.durationMs, voice.hasVideo, voice.width], [4200, false, null]);
});

test('the ffmpeg argument lists match the contract', () => {
  const video = buildVideoArgs({ input: 'in.mov', output: 'out.tmp' });
  const joined = video.join(' ');
  assert.ok(
    joined.includes(
      "-map 0:v:0 -map 0:a:0? -map_metadata -1 -map_chapters -1 -vf scale=-2:'min(720,ih)',format=yuv420p -c:v libx264 -profile:v high -preset veryfast -crf 23 -maxrate 3M -bufsize 6M -c:a aac -b:a 128k -ac 2 -movflags +faststart -f mp4 out.tmp",
    ),
    joined,
  );
  assert.equal(video[video.indexOf('-i') + 1], 'in.mov');
  assert.match(buildVideoArgs({ input: 'a', output: 'b', hdr: true }).join(' '), /-vf zscale=t=linear:npl=100,format=gbrpf32le,zscale=p=bt709,tonemap=tonemap=hable:desat=0,zscale=t=bt709:m=bt709:r=tv,scale/);

  assert.ok(buildVoiceArgs({ input: 'a.webm', output: 'b' }).join(' ').includes('-vn -t 65 -map_metadata -1 -ac 1 -c:a aac -b:a 64k -movflags +faststart -f mp4 b'));
  assert.deepEqual([posterSeconds(500), posterSeconds(1000), posterSeconds(null)], [0, 1, 1]);
  assert.equal(buildPosterArgs({ input: 'a', output: 'b', durationMs: 300 })[buildPosterArgs({ input: 'a', output: 'b', durationMs: 300 }).indexOf('-ss') + 1], '0');
});

test('detectType trusts bytes, not names', async (t) => {
  const box = (brand, compat = []) => {
    const body = Buffer.concat([Buffer.from(brand), Buffer.alloc(4), ...compat.map((b) => Buffer.from(b))]);
    const size = Buffer.alloc(4);
    size.writeUInt32BE(8 + body.length);
    return Buffer.concat([size, Buffer.from('ftyp'), body, Buffer.alloc(16)]);
  };
  assert.equal(detectType(await makeJpeg()).mime, 'image/jpeg');
  assert.equal(detectType(await makePng()).mime, 'image/png');
  assert.equal(detectType(box('heic', ['mif1', 'heic'])).mime, 'image/heic');
  assert.equal(detectType(box('mif1', ['heic'])).mime, 'image/heif');
  assert.equal(detectType(box('avif', ['mif1'])).mime, 'image/avif');
  assert.deepEqual(detectType(box('qt  ')), { kind: 'video', mime: 'video/quicktime', ext: 'mov' });
  assert.equal(detectType(box('isom', ['mp42'])).mime, 'video/mp4');
  assert.equal(detectType(box('3gp5')).ext, '3gp');
  assert.equal(detectType(box('M4A ')).kind, 'audio');
  assert.equal(detectType(Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0, 0, 0, 0, 0, 0, 0, 0])).mime, 'video/webm');
  assert.equal(detectType(Buffer.from('RIFF\0\0\0\0WEBPVP8 ')).mime, 'image/webp');
  assert.equal(detectType(Buffer.from('<html><body>hello</body></html>')), null);
  assert.equal(detectType(Buffer.from('tiny')), null);

  const dir = await makeTempDir();
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  await fs.writeFile(path.join(dir, 'photo.mov'), await makeJpeg());
  assert.equal((await sniffFile(path.join(dir, 'photo.mov'))).mime, 'image/jpeg');
});

test('exec runs a tool, reports failures with stderr, honours abort and spots missing binaries', async () => {
  const node = process.execPath;
  assert.equal((await exec(node, ['-e', 'process.stdout.write("hi")'])).stdout, 'hi');
  await assert.rejects(exec(node, ['-e', 'console.error("bad input"); process.exit(3)']), (err) => {
    assert.ok(err instanceof MediaToolError);
    assert.equal(err.exitCode, 3);
    assert.match(err.stderr, /bad input/);
    return true;
  });
  const controller = new AbortController();
  const slow = exec(node, ['-e', 'setTimeout(() => {}, 10000)'], { signal: controller.signal });
  setTimeout(() => controller.abort(), 50);
  await assert.rejects(slow, /cancelled/);
  await assert.rejects(exec(node, ['-e', 'setTimeout(() => {}, 10000)'], { timeoutMs: 50 }), /took longer/);
  await assert.rejects(exec('/nonexistent/ffmpeg', []), MissingBinaryError);
});

test('findBinary searches PATH; createMediaTools says which tool is missing', () => {
  assert.equal(findBinary('node', { envPath: path.dirname(process.execPath) }), process.execPath);
  assert.equal(findBinary('definitely-not-a-tool-gma', { envPath: '/usr/bin' }), null);
  const tools = createMediaTools({ which: () => null });
  assert.equal(tools.has('ffmpeg'), false);
  assert.throws(() => tools.binary('heif-dec'), /heif-dec is not installed/);
});

test('describeSeconds reads naturally', () => {
  assert.equal(describeSeconds(45), '45 seconds');
  assert.equal(describeSeconds(60), '1 minute');
  assert.equal(describeSeconds(90), '1 minute 30 seconds');
  assert.equal(describeSeconds(240), '4 minutes');
  assert.equal(describeSeconds(1), '1 second');
});

// The real tools. They are not installed on Ben's Mac (and must not be); the
// Docker image has them, and `npm test` there runs these.
test('ffmpeg + ffprobe: a generated clip goes through the real video pipeline', { skip: !(BIN.ffmpeg && BIN.ffprobe) && 'ffmpeg/ffprobe not installed here; runs in the Docker image' }, async (t) => {
  const dir = await makeTempDir();
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const clip = path.join(dir, 'clip.mp4');
  await exec(BIN.ffmpeg, ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc=size=1280x720:rate=30', '-f', 'lavfi', '-i', 'sine=frequency=440', '-t', '2', '-c:v', 'libx264', '-c:a', 'aac', '-shortest', clip]);
  const tools = createMediaTools();
  const probe = await tools.probe(clip);
  assert.equal(probe.width, 1280);
  assert.ok(probe.durationMs >= 1900 && probe.durationMs <= 2200);
  const out = path.join(dir, 'out.tmp');
  await tools.transcodeVideo({ input: clip, output: out, hdr: false });
  const result = await tools.probe(out);
  assert.deepEqual([result.width, result.height, result.hasAudio], [1280, 720, true]);
  const poster = path.join(dir, 'poster.png');
  await tools.extractPoster({ input: clip, output: poster, durationMs: probe.durationMs });
  assert.equal(detectType(await fs.readFile(poster)).mime, 'image/png');
  const voice = path.join(dir, 'voice.tmp');
  await tools.transcodeVoice({ input: clip, output: voice });
  const v = await tools.probe(voice);
  assert.deepEqual([v.hasVideo, v.hasAudio], [false, true]);
});

test('heif-dec: decodes a HEIC to PNG', { skip: !BIN.heifDec && 'heif-dec not installed here; runs in the Docker image' }, async (t) => {
  const sharp = (await import('sharp')).default;
  const dir = await makeTempDir();
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const heic = path.join(dir, 'in.heic');
  try {
    await sharp(await makePng()).heif({ compression: 'hevc' }).toFile(heic);
  } catch {
    t.skip('this sharp build cannot encode HEVC to make a fixture');
    return;
  }
  const out = path.join(dir, 'out.png');
  await createMediaTools().heifToPng({ input: heic, output: out });
  assert.equal(detectType(await fs.readFile(out)).mime, 'image/png');
});
