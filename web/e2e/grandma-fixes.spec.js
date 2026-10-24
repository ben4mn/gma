// Review fixes on the real Grandma screens (fixture data, paired frame):
// a video stops with the screen it was on (F1), and the voice recorder survives
// double taps on Record and Stop without losing or doubling a take (F2, F6).
import { test, expect } from '@playwright/test';
import { FRAME_URL, GRANDMA_VIEWPORT, audit, shoot } from './helpers.js';

const SETTLE = 800; // a little longer than the voice screen's SETTLE_MS

test.describe.serial('Grandma screens: videos and voice under real taps', () => {
  let frame;

  test.beforeAll(async ({ browser }) => {
    const context = await browser.newContext({ viewport: GRANDMA_VIEWPORT });
    await context.addInitScript(() => {
      // every <video> that ever played, to catch one that goes on playing off screen
      window.__videos = new Set();
      const play = HTMLMediaElement.prototype.play;
      HTMLMediaElement.prototype.play = function (...args) {
        if (this instanceof HTMLVideoElement) window.__videos.add(this);
        return play.apply(this, args);
      };
      // a slow microphone, like a real first getUserMedia, that counts its calls
      window.__gum = 0;
      window.__tracks = [];
      if (navigator.mediaDevices) {
        navigator.mediaDevices.getUserMedia = async () => {
          window.__gum += 1;
          await new Promise((r) => setTimeout(r, 300));
          const audio = new AudioContext();
          const out = audio.createMediaStreamDestination();
          const tone = audio.createOscillator();
          tone.connect(out);
          tone.start();
          window.__tracks.push(...out.stream.getTracks());
          return out.stream;
        };
      }
    });
    frame = await context.newPage();
    await frame.goto(FRAME_URL); // pairs this browser
  });

  test.afterAll(async () => { await frame?.context().close(); });

  test('reacting mid-video stops it, and Play afterwards plays on the screen (F1)', async () => {
    await frame.goto('/grandma/?fixture=1&state=video');
    await expect(frame.locator('.play-big')).toBeVisible();
    // A real, playable clip made in the page (the fixture's video file doesn't exist).
    await frame.evaluate(async () => {
      const canvas = Object.assign(document.createElement('canvas'), { width: 320, height: 240 });
      const g = canvas.getContext('2d');
      const rec = new MediaRecorder(canvas.captureStream(30), { mimeType: 'video/webm' });
      const chunks = [];
      rec.ondataavailable = (e) => chunks.push(e.data);
      let f = 0;
      const paint = setInterval(() => { g.fillStyle = `hsl(${(f += 9) % 360} 50% 50%)`; g.fillRect(0, 0, 320, 240); }, 33);
      rec.start();
      await new Promise((r) => setTimeout(r, 6000));
      const stopped = new Promise((r) => { rec.onstop = r; });
      rec.stop();
      await stopped;
      clearInterval(paint);
      const url = URL.createObjectURL(new Blob(chunks, { type: 'video/webm' }));
      const { ctx, go } = window.__gmaFixture;
      const v = ctx.state;
      const it = [...v.cards.flatMap((c) => c.items), ...v.slideshow].find((i) => i.kind === 'video');
      go('item', { items: [{ ...it, video: url, durationMs: 6000 }], index: 0 });
    });
    const playing = () => frame.evaluate(() => {
      const v = document.querySelector('video');
      return Boolean(v && v.isConnected && !v.paused && v.currentTime > 0.2);
    });
    const strays = () => frame.evaluate(() => [...window.__videos].filter((v) => !v.isConnected && !v.paused).length);

    await frame.locator('.play-big').click();
    await expect.poll(playing).toBe(true);
    await frame.getByRole('button', { name: 'Love' }).click();
    await expect(frame.locator('.sent')).toBeVisible();
    expect(await frame.locator('video').count(), 'the video left with its screen').toBe(0);
    expect(await strays(), 'nothing plays off screen').toBe(0);

    await frame.getByRole('button', { name: 'OK' }).click();
    await expect(frame.locator('.play-big')).toBeVisible();
    await frame.locator('.play-big').click();
    await expect.poll(playing, { message: 'a new video on this screen plays' }).toBe(true);
    await expect(frame.locator('.play-big')).toBeHidden();
    expect(await strays()).toBe(0);
    await frame.getByRole('button', { name: 'Home' }).click();
    await expect(frame.locator('video')).toHaveCount(0);
  });

  test('double taps on Record and Stop keep exactly one take (F2, F6)', async () => {
    await frame.goto('/grandma/?fixture=1&state=voice');
    const record = frame.locator('.rec-btn');
    await expect(record).toBeVisible();
    await frame.waitForTimeout(SETTLE);

    await record.dblclick();
    await expect(frame.locator('.rec-btn.is-recording')).toBeVisible();
    expect(await frame.evaluate(() => window.__gum), 'one microphone, not two').toBe(1);
    await frame.waitForTimeout(1500);
    await shoot(frame, 'grandma-recording');
    const recording = await audit(frame, 'grandma');
    expect(recording.issues, 'the recording screen passes the audit').toEqual([]);

    // Two taps 150 ms apart on the word "Stop".
    const stop = await frame.locator('.rec-btn.is-recording').boundingBox();
    const at = { x: stop.x + stop.width / 2, y: stop.y + stop.height * 0.65 };
    await frame.mouse.click(at.x, at.y);
    await frame.waitForTimeout(150);
    await frame.mouse.click(at.x, at.y);
    await expect(frame.locator('.listen-btn')).toBeVisible();
    await frame.waitForTimeout(400);
    await expect(frame.locator('.listen-btn'), 'the take is still there').toBeVisible();
    expect(await frame.evaluate(() => window.__tracks.every((t) => t.readyState === 'ended')), 'the microphone is off').toBe(true);

    const again = await frame.locator('.again-btn').boundingBox();
    const overlaps = again.x < stop.x + stop.width && again.x + again.width > stop.x
      && again.y < stop.y + stop.height && again.y + again.height > stop.y;
    expect(overlaps, '"Record again" is clear of where Stop was').toBe(false);
    await shoot(frame, 'grandma-recorded');
    const recorded = await audit(frame, 'grandma');
    expect(recorded.issues, 'the recorded screen passes the audit').toEqual([]);

    // "Record again" keeps the take until a new one is made.
    await frame.waitForTimeout(SETTLE);
    await frame.locator('.again-btn').click();
    await expect(frame.getByRole('button', { name: 'Keep my last message' })).toBeVisible();
    await frame.waitForTimeout(SETTLE);
    await frame.getByRole('button', { name: 'Keep my last message' }).click();
    await expect(frame.locator('.listen-btn')).toBeVisible();
    await frame.getByRole('button', { name: 'Home' }).click();
  });
});
