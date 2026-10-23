// The whole family loop on the real app and worker: Ben invites a relative, she
// joins with an email code and sets up a passkey, signs out and back in with it,
// shares a photo, Grandma's frame shows it, Grandma reacts and sends a message,
// and it all comes back to the relative's Grandma's Feed and Mine. Then the frame
// goes offline, Grandma reacts anyway, and the reaction arrives exactly once.
import path from 'node:path';
import { test, expect } from '@playwright/test';
import {
  ADMIN_EMAIL, FAMILY_VIEWPORT, FRAME_URL, GRANDMA_VIEWPORT,
  addVirtualAuthenticator, codeFor, logSize, setNight, signInWithCode, skipPasskeyOffer, watchExternal,
} from './helpers.js';

const RELATIVE = { name: 'Rosie', email: 'rosie@example.com' };
const PHOTO = path.resolve(import.meta.dirname, '../../server/test/fixtures/landscape.jpg');
const CAPTION = 'Lily at the farm';

test.describe.serial('the family loop', () => {
  let browser;
  let admin; // Ben's phone
  let relative; // Rosie's phone
  let frame; // Grandma's frame
  let inviteUrl;
  const externalLists = [];

  test.beforeAll(async ({ browser: b }) => {
    browser = b;
  });

  test.afterAll(async () => {
    await admin?.context().close();
    await relative?.context().close();
    await frame?.context().close();
    expect(externalLists.flat(), 'nothing leaves the app').toEqual([]);
  });

  async function newPage(viewport) {
    const context = await browser.newContext({ viewport });
    const page = await context.newPage();
    externalLists.push(watchExternal(page));
    return page;
  }

  test('Ben signs in with a code and makes an invite to share by text', async () => {
    admin = await newPage(FAMILY_VIEWPORT);
    await signInWithCode(admin, ADMIN_EMAIL);
    await skipPasskeyOffer(admin);
    await expect(admin.getByRole('heading', { name: 'Family', exact: true })).toBeVisible();
    // keep the frame awake whatever time the suite runs (night has its own audit)
    await setNight(admin.request, { asleep: false });

    await admin.goto('/admin');
    await admin.getByLabel('Name', { exact: true }).fill(RELATIVE.name);
    await admin.getByLabel('Email', { exact: true }).fill(RELATIVE.email);
    await admin.getByLabel('Email the invite to them').uncheck();
    await admin.getByRole('button', { name: 'Create invite' }).click();
    const link = admin.locator('.once-link');
    await expect(link).toContainText('/join/');
    inviteUrl = (await link.textContent()).trim();
  });

  test('Rosie joins with the code, then sets up Face ID', async () => {
    relative = await newPage(FAMILY_VIEWPORT);
    await addVirtualAuthenticator(relative);
    await relative.goto(inviteUrl);
    await expect(relative.getByRole('heading', { name: 'Welcome to Grandma’s family' })).toBeVisible();
    await expect(relative.getByLabel('Your name')).toHaveValue(RELATIVE.name);
    const since = await logSize();
    await relative.getByLabel('Your email').fill(RELATIVE.email);
    await relative.getByRole('button', { name: 'Continue' }).click();
    await expect(relative.getByRole('heading', { name: 'Check your email' })).toBeVisible();
    await relative.getByLabel('Your code').fill(await codeFor(RELATIVE.email, { since }));

    await expect(relative.getByRole('heading', { name: 'Use Face ID or your fingerprint next time' })).toBeVisible();
    const setUp = relative.getByRole('button', { name: 'Set it up' });
    await expect(setUp).toBeEnabled();
    await setUp.click();
    await expect(relative.getByRole('heading', { name: 'All set' })).toBeVisible();
    await relative.getByRole('button', { name: 'Continue' }).click();
    await expect(relative.getByRole('heading', { name: 'Family', exact: true })).toBeVisible();

    const me = await (await relative.request.get('/api/me')).json();
    expect(me.passkeys).toBe(1);
    expect(me.user.status).toBe('active');
  });

  test('Rosie signs out and back in with her passkey', async () => {
    await relative.goto('/you');
    await relative.getByRole('button', { name: 'Sign out' }).click();
    await expect(relative.getByRole('heading', { name: 'Welcome back' })).toBeVisible();
    const passkey = relative.getByRole('button', { name: 'Sign in with Face ID or fingerprint' });
    await expect(passkey).toBeEnabled();
    await passkey.click();
    await expect(relative.getByRole('heading', { name: 'Family', exact: true })).toBeVisible();
    const me = await (await relative.request.get('/api/me')).json();
    expect(me.user.email).toBe(RELATIVE.email);
  });

  test('Rosie shares a photo; it gets ready', async () => {
    await relative.goto('/upload');
    await relative.getByLabel('Choose photos or videos').setInputFiles(PHOTO);
    await relative.getByLabel('Add a few words (optional)').fill(CAPTION);
    await relative.getByRole('button', { name: 'Send to Grandma and the family' }).click();
    await expect(relative.getByText('All sent!')).toBeVisible({ timeout: 30_000 });
    await relative.getByRole('link', { name: 'See them in Mine' }).click();
    await expect(relative.getByRole('heading', { name: 'Mine' })).toBeVisible();
    // the worker makes the renditions; Mine flips from "Getting it ready…" by itself (SSE)
    const post = relative.locator('article.post', { hasText: CAPTION });
    await expect(post.locator('img').first()).toBeVisible({ timeout: 30_000 });
    await expect(post.getByText('When Grandma reacts, it shows here.')).toBeVisible();
  });

  test('the frame shows it as new; Grandma loves it', async () => {
    frame = await newPage(GRANDMA_VIEWPORT);
    await frame.goto(FRAME_URL);
    await expect(frame).toHaveURL(/\/grandma\/$/);
    const card = frame.locator('.pcard', { hasText: `from ${RELATIVE.name}` });
    await expect(card).toBeVisible();
    await card.click();
    await expect(frame.locator('.note-name')).toHaveText(RELATIVE.name);
    await expect(frame.locator('.note-text')).toHaveText(CAPTION);
    await frame.getByRole('button', { name: 'Love' }).click();
    await expect(frame.locator('.sent')).toBeVisible();
  });

  test('Grandma sends a message to Rosie only', async () => {
    // the sent screen returns to the photo by itself after 4 s
    const send = frame.getByRole('button', { name: 'Send a message' });
    await expect(send).toBeVisible({ timeout: 10_000 });
    await send.click();
    await expect(frame.getByRole('heading', { name: `Send ${RELATIVE.name} a message` })).toBeVisible();
    await frame.getByRole('button', { name: 'Call me' }).click();
    await expect(frame.locator('.sent')).toContainText('Call me');
  });

  test('Rosie sees both in Grandma’s Feed and on Mine', async () => {
    await relative.goto('/from-grandma');
    const feed = relative.locator('main');
    await expect(feed.getByText('Call me').first()).toBeVisible();
    await expect(feed.locator('.g-what', { hasText: 'Love' }).first()).toBeVisible();
    await relative.goto('/mine');
    const post = relative.locator('article.post', { hasText: CAPTION });
    await expect(post.locator('.chip', { hasText: 'Love' })).toBeVisible();
    await expect(post.locator('.chip--note', { hasText: 'Call me' })).toBeVisible();
  });

  test('offline: a reaction waits in the outbox and arrives exactly once', async () => {
    const before = await (await relative.request.get('/api/grandma-events?limit=100')).json();
    const funnyBefore = before.events.filter((e) => e.reaction === 'funny').length;

    await frame.getByRole('button', { name: 'Home' }).click();
    await frame.locator('.hero').click();
    await expect(frame.getByRole('button', { name: 'Funny' })).toBeVisible();
    await frame.context().setOffline(true);
    await frame.evaluate(() => window.dispatchEvent(new Event('offline')));
    await frame.getByRole('button', { name: 'Funny' }).click();
    await expect(frame.locator('.sent')).toBeVisible();
    await frame.waitForTimeout(1500);
    const during = await (await relative.request.get('/api/grandma-events?limit=100')).json();
    expect(during.events.filter((e) => e.reaction === 'funny').length).toBe(funnyBefore);

    await frame.context().setOffline(false);
    await frame.evaluate(() => window.dispatchEvent(new Event('online')));
    await expect.poll(async () => {
      const after = await (await relative.request.get('/api/grandma-events?limit=100')).json();
      return after.events.filter((e) => e.reaction === 'funny').length;
    }, { timeout: 40_000 }).toBe(funnyBefore + 1);
    // and it stays once, even after the outbox's next retry tick
    await frame.waitForTimeout(2000);
    const settled = await (await relative.request.get('/api/grandma-events?limit=100')).json();
    expect(settled.events.filter((e) => e.reaction === 'funny').length).toBe(funnyBefore + 1);
  });
});
