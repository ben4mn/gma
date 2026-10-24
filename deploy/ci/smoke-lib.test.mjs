// node --test 'deploy/ci/*.test.mjs'   (pure: no ffmpeg, no sharp, no network)

import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  checkFaststart,
  checkStill,
  checkStillMetadata,
  checkVideoRendition,
  checkVoiceRendition,
  exifHasGps,
  privateTags,
  summarise,
  topLevelBoxes,
} from './smoke-lib.mjs';

function box(type, payload = Buffer.alloc(0)) {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(8 + payload.length, 0);
  head.write(type, 4, 'latin1');
  return Buffer.concat([head, payload]);
}

function largeBox(type, payload) {
  const head = Buffer.alloc(16);
  head.writeUInt32BE(1, 0);
  head.write(type, 4, 'latin1');
  head.writeBigUInt64BE(BigInt(16 + payload.length), 8);
  return Buffer.concat([head, payload]);
}

test('topLevelBoxes walks 32-bit, 64-bit and to-the-end boxes', () => {
  const tail = Buffer.alloc(12);
  tail.write('mdat', 4, 'latin1'); // size 0: runs to the end
  const file = Buffer.concat([box('ftyp', Buffer.alloc(8)), largeBox('moov', Buffer.alloc(20)), tail]);
  assert.deepEqual(
    topLevelBoxes(file).map((b) => [b.type, b.size]),
    [['ftyp', 16], ['moov', 36], ['mdat', 12]],
  );
});

test('topLevelBoxes stops at a broken box instead of looping', () => {
  const broken = Buffer.alloc(8); // size 0 is fine, size 3 is not
  broken.writeUInt32BE(3, 0);
  broken.write('junk', 4, 'latin1');
  assert.deepEqual(topLevelBoxes(Buffer.concat([box('ftyp'), broken])).map((b) => b.type), ['ftyp']);
});

test('checkFaststart wants moov before mdat', () => {
  assert.deepEqual(checkFaststart(Buffer.concat([box('ftyp'), box('moov'), box('mdat')])), []);
  assert.match(checkFaststart(Buffer.concat([box('ftyp'), box('mdat'), box('moov')]))[0], /moov comes after mdat/);
  assert.deepEqual(checkFaststart(Buffer.concat([box('ftyp'), box('mdat')])), ['there is no moov box']);
});

const goodVideo = () => ({
  format: { format_name: 'mov,mp4,m4a,3gp,3g2,mj2', tags: { major_brand: 'isom', encoder: 'Lavf61.7.100' } },
  streams: [
    { codec_type: 'video', codec_name: 'h264', profile: 'High', pix_fmt: 'yuv420p', bits_per_raw_sample: '8', width: 720, height: 1280, color_transfer: 'bt709', tags: { handler_name: 'VideoHandler' } },
    { codec_type: 'audio', codec_name: 'aac', channels: 2 },
  ],
});

test('checkVideoRendition passes the contract rendition', () => {
  assert.deepEqual(checkVideoRendition(goodVideo()), []);
});

test('checkVideoRendition names every way a rendition can be wrong', () => {
  const p = goodVideo();
  Object.assign(p.streams[0], { codec_name: 'hevc', profile: 'Main 10', pix_fmt: 'yuv420p10le', bits_per_raw_sample: '10', width: 1080, height: 1920, color_transfer: 'arib-std-b67' });
  p.streams[1].codec_name = 'opus';
  p.format.tags['com.apple.quicktime.location.ISO6709'] = '+40.7128-074.0060/';
  p.streams[0].tags.creation_time = '2024-06-01T15:30:00.000000Z';
  const problems = checkVideoRendition(p).join('\n');
  for (const words of ['not h264', 'not High', 'not yuv420p', 'not 8', 'short side is 1080', 'tone-mapped', 'not aac', 'ISO6709', 'creation_time']) {
    assert.match(problems, new RegExp(words), words);
  }
});

test('checkVideoRendition notices a missing audio track and odd sizes', () => {
  const p = goodVideo();
  p.streams.pop();
  p.streams[0].width = 721;
  p.streams[0].height = 1281;
  const problems = checkVideoRendition(p).join('\n');
  assert.match(problems, /no audio stream/);
  assert.match(problems, /not even/);
  assert.deepEqual(checkVideoRendition({ streams: [] }), ['there is no video stream']);
});

test('privateTags finds location, dates and the camera, but not the muxer', () => {
  const found = privateTags({
    format: { tags: { location: '+40.7128-074.0060/', 'location-eng': 'x', encoder: 'Lavf', major_brand: 'isom' } },
    streams: [{ codec_type: 'video', tags: { creation_time: 'x', 'com.apple.quicktime.make': 'Apple', handler_name: 'Core Media Video' } }],
  });
  assert.equal(found.length, 4);
  assert.ok(found.every((f) => !/encoder|major_brand|handler_name/.test(f)));
});

test('checkVoiceRendition wants mono AAC in MP4 with no video', () => {
  const good = { format: { format_name: 'mov,mp4,m4a,3gp,3g2,mj2' }, streams: [{ codec_type: 'audio', codec_name: 'aac', channels: 1 }] };
  assert.deepEqual(checkVoiceRendition(good), []);
  const bad = { format: { format_name: 'matroska,webm' }, streams: [{ codec_type: 'video' }, { codec_type: 'audio', codec_name: 'opus', channels: 2 }] };
  const problems = checkVoiceRendition(bad).join('\n');
  for (const words of ['video stream', 'not aac', 'not 1', 'not mp4']) assert.match(problems, new RegExp(words), words);
  assert.deepEqual(checkVoiceRendition({ streams: [] }), ['there is no audio stream']);
});

test('checkStill checks the codec and the longest side', () => {
  const still = (codec_name, width, height) => ({ streams: [{ codec_type: 'video', codec_name, width, height }] });
  assert.deepEqual(checkStill(still('mjpeg', 1600, 1067), { codec: 'mjpeg', maxSide: 1600 }), []);
  assert.equal(checkStill(still('png', 1601, 900), { codec: 'mjpeg', maxSide: 1600 }).length, 2);
  assert.deepEqual(checkStill({ streams: [] }, { codec: 'webp', maxSide: 480 }), ['ffprobe found no image']);
});

test('checkStillMetadata refuses EXIF, XMP and IPTC', () => {
  assert.deepEqual(checkStillMetadata({ format: 'jpeg', width: 10 }), []);
  assert.equal(checkStillMetadata({ exif: Buffer.alloc(40), xmp: Buffer.alloc(1), iptc: Buffer.alloc(1) }).length, 3);
});

test('exifHasGps finds the GPS IFD pointer in either byte order', () => {
  const le = Buffer.concat([Buffer.from('Exif\0\0II*\0', 'latin1'), Buffer.from([0x08, 0, 0, 0, 0x25, 0x88, 4, 0])]);
  const be = Buffer.concat([Buffer.from('Exif\0\0MM\0*', 'latin1'), Buffer.from([0, 0, 0, 0x08, 0x88, 0x25, 0, 4])]);
  const none = Buffer.concat([Buffer.from('Exif\0\0II*\0', 'latin1'), Buffer.from([0x08, 0, 0, 0, 0x0f, 0x01, 2, 0])]);
  assert.equal(exifHasGps(le), true);
  assert.equal(exifHasGps(be), true);
  assert.equal(exifHasGps(none), false);
  assert.equal(exifHasGps(undefined), false);
});

test('summarise marks a run failed when any check has problems', () => {
  assert.deepEqual(summarise([{ name: 'a', problems: [] }]), { ok: true, lines: ['ok   a'] });
  const out = summarise([{ name: 'a', problems: [] }, { name: 'b', problems: ['too big'] }]);
  assert.equal(out.ok, false);
  assert.deepEqual(out.lines, ['ok   a', 'FAIL b', '     - too big']);
});
