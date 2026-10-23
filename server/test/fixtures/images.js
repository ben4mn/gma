// Small generated test images (no real people). sharp draws them on the fly so
// the repo carries no binary fixtures besides landscape.jpg, a 1600x589 sample
// copied from design/assets/photos (Unsplash, see its ATTRIBUTION.md).

import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

export const LANDSCAPE_JPG = fileURLToPath(new URL('./landscape.jpg', import.meta.url));

function canvas(width, height) {
  // Two colour bands, so orientation mistakes show up in pixel checks.
  const top = Buffer.alloc(width * Math.ceil(height / 2) * 3);
  for (let i = 0; i < top.length; i += 3) top.set([200, 60, 30], i);
  const bottom = Buffer.alloc(width * Math.floor(height / 2) * 3);
  for (let i = 0; i < bottom.length; i += 3) bottom.set([40, 90, 200], i);
  return sharp(Buffer.concat([top, bottom]), { raw: { width, height, channels: 3 } });
}

// A JPEG with an EXIF orientation and a GPS position, like a phone photo.
export async function makeJpeg({ width = 600, height = 400, orientation = 1, gps = true } = {}) {
  const exif = { IFD0: { Make: 'TestCam', Model: 'Fixture 1' } };
  if (gps) exif.IFD3 = { GPSLatitudeRef: 'N', GPSLatitude: '41/1 52/1 0/1', GPSLongitudeRef: 'W', GPSLongitude: '87/1 37/1 0/1' };
  return canvas(width, height).jpeg({ quality: 90 }).withExif(exif).withMetadata({ orientation }).toBuffer();
}

export async function makePng({ width = 300, height = 300 } = {}) {
  return canvas(width, height).png().toBuffer();
}
