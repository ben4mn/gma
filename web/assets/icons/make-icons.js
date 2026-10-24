// Renders icon.svg to the PNGs the manifest and iOS need, with Playwright's
// headless shell (already cached on the dev machine; never Google Chrome).
// Run with `npm run icons` from web/. The PNGs are committed.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const dir = dirname(fileURLToPath(import.meta.url));
const svg = readFileSync(join(dir, 'icon.svg'), 'utf8');
const outputs = [
  ['icon-192.png', 192],
  ['icon-512.png', 512],
  ['icon-maskable-512.png', 512],
  ['apple-touch-icon.png', 180],
];

const browser = await chromium.launch();
try {
  for (const [name, size] of outputs) {
    const page = await browser.newPage({ viewport: { width: size, height: size } });
    await page.setContent(`<!doctype html><style>html,body{margin:0}svg{display:block;width:${size}px;height:${size}px}</style>${svg}`);
    await page.screenshot({ path: join(dir, name), clip: { x: 0, y: 0, width: size, height: size } });
    await page.close();
    console.log('wrote', name);
  }
} finally {
  await browser.close();
}
