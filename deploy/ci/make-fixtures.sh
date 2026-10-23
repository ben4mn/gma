#!/usr/bin/env bash
# Makes the media smoke test's inputs. Runs inside a throwaway gma:ci container
# as root (deploy/ci-on-server.sh starts it), because heif-enc needs an HEVC
# encoder plugin the production image deliberately doesn't ship:
#
#   bash /ci/make-fixtures.sh <photo.jpg> <out dir>
#
# Writes, all owned by uid 1000 so the host user can delete them:
#   photo-gps.jpg                 the photo with a GPS position written into its EXIF
#   photo.heic                    the same photo through heif-enc (HEVC, EXIF kept), like an iPhone's
#   portrait-1080x1920-h264.mov   10 s, 30 fps, H.264 + AAC stereo, with a location and a creation time
#   hdr-3840x2160-hevc10-hlg.mov  5 s, 30 fps, HEVC Main 10, BT.2020 HLG (hvc1, like an iPhone), + AAC
#   voice.webm                    6 s Opus stereo in WebM, like a browser's MediaRecorder
#   tiny.heic                     64x48 HEIC for server/test/fixtures (copied to the results)
set -euo pipefail

SRC=${1:?usage: make-fixtures.sh <photo.jpg> <out dir>}
OUT=${2:?usage: make-fixtures.sh <photo.jpg> <out dir>}
LOCATION='+40.7128-074.0060/'          # smoke.mjs looks for this string in the renditions
FILMED='2024-06-01T15:30:00.000000Z'

say() { printf '[fixtures] %s\n' "$*"; }

mkdir -p "$OUT"
cd "$OUT"

say "installing the HEVC encoder plugin for heif-enc (this container only)"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq >/dev/null
apt-get install -y -qq --no-install-recommends libheif-plugin-x265 >/dev/null
rm -rf /var/lib/apt/lists/*

say "photo-gps.jpg: adding a GPS position to $(basename "$SRC")"
node - "$SRC" photo-gps.jpg <<'NODE'
const { createRequire } = require('node:module');
const sharp = createRequire('/app/server/package.json')('sharp');
const [src, out] = process.argv.slice(2);
sharp(src)
  .withExif({
    IFD0: { Make: 'Apple', Model: 'iPhone 15 Pro' },
    IFD3: {
      GPSLatitudeRef: 'N', GPSLatitude: '40/1 42/1 4608/100',
      GPSLongitudeRef: 'W', GPSLongitude: '74/1 0/1 2160/100',
    },
  })
  .jpeg({ quality: 90 })
  .toFile(out)
  .then((info) => console.log(`[fixtures]   ${info.width}x${info.height}`))
  .catch((err) => { console.error(err); process.exit(1); });
NODE

say "photo.heic: heif-enc"
heif-enc --quality 80 --output photo.heic photo-gps.jpg
heif-info photo.heic | sed 's/^/[fixtures]   /'

# A 64x48 HEIC for server/test/fixtures: the image has heif-dec but no HEVC
# encoder, so media-lib.test.js can only run its heif-dec case on a committed file.
say "tiny.heic: a 64x48 HEIC fixture for the server tests"
node - tiny.png <<'NODE'
const { createRequire } = require('node:module');
const sharp = createRequire('/app/server/package.json')('sharp');
sharp({ create: { width: 64, height: 48, channels: 3, background: { r: 184, g: 134, b: 43 } } })
  .png().toFile(process.argv[2]).catch((err) => { console.error(err); process.exit(1); });
NODE
heif-enc --quality 50 --output tiny.heic tiny.png
rm -f tiny.png

say "portrait-1080x1920-h264.mov"
ffmpeg -hide_banner -loglevel error -nostdin -y \
  -f lavfi -i 'testsrc2=size=1080x1920:rate=30' \
  -f lavfi -i 'sine=frequency=440:sample_rate=48000' \
  -t 10 -c:v libx264 -preset veryfast -profile:v high -pix_fmt yuv420p \
  -c:a aac -ac 2 -b:a 128k \
  -metadata creation_time="$FILMED" -metadata location="$LOCATION" \
  -metadata com.apple.quicktime.location.ISO6709="$LOCATION" \
  -metadata com.apple.quicktime.make=Apple -metadata com.apple.quicktime.model='iPhone 15 Pro' \
  -movflags use_metadata_tags \
  portrait-1080x1920-h264.mov

say "hdr-3840x2160-hevc10-hlg.mov"
ffmpeg -hide_banner -loglevel error -nostdin -y \
  -f lavfi -i 'testsrc2=size=3840x2160:rate=30' \
  -f lavfi -i 'sine=frequency=660:sample_rate=48000' \
  -t 5 -vf 'format=yuv420p10le' \
  -c:v libx265 -preset ultrafast -tag:v hvc1 \
  -x265-params 'log-level=error:colorprim=bt2020:transfer=arib-std-b67:colormatrix=bt2020nc:range=limited' \
  -color_primaries bt2020 -color_trc arib-std-b67 -colorspace bt2020nc -color_range tv \
  -c:a aac -ac 2 -b:a 128k \
  -metadata creation_time="$FILMED" -metadata location="$LOCATION" \
  -metadata com.apple.quicktime.location.ISO6709="$LOCATION" \
  -movflags use_metadata_tags \
  hdr-3840x2160-hevc10-hlg.mov

say "voice.webm"
ffmpeg -hide_banner -loglevel error -nostdin -y \
  -f lavfi -i 'sine=frequency=330:sample_rate=48000:duration=6' \
  -ac 2 -c:a libopus -b:a 48k \
  voice.webm

chown -R 1000:1000 "$OUT"
say "done:"
ls -l "$OUT" | sed 's/^/[fixtures]   /'
