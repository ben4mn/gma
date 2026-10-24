// Every admin screen on the real app, signed in as Ben: each one renders the
// server's real data (the demo family, its uploads, the paired frames, the
// preset messages, night hours and health) with no error and no page error.
// Ben also changes what Grandma calls someone, and makes and cancels an invite.
import { test, expect } from '@playwright/test';
import { ADMIN_EMAIL, FAMILY_VIEWPORT, ORIGIN_HEADERS, audit, shoot, signInWithCode, skipPasskeyOffer, watchExternal } from './helpers.js';

test.describe.serial('the admin screens', () => {
  let page;
  let external;
  const errors = [];

  test.beforeAll(async ({ browser }) => {
    const context = await browser.newContext({ viewport: FAMILY_VIEWPORT });
    page = await context.newPage();
    external = watchExternal(page);
    page.on('pageerror', (err) => errors.push(err.message));
    page.on('console', (msg) => {
      if (msg.type() === 'error' && !/Failed to load resource/.test(msg.text())) errors.push(msg.text());
    });
    await signInWithCode(page, ADMIN_EMAIL);
    await skipPasskeyOffer(page);
  });

  test.afterAll(async () => {
    await page?.context().close();
    expect(external, 'nothing leaves the app').toEqual([]);
  });

  // No error box, no visible form error, no page error on the screen.
  async function expectCalm(name) {
    await expect(page.locator('.note--error')).toHaveCount(0);
    await expect(page.locator('.form-error:visible')).toHaveCount(0);
    await expect(page.getByText('Loading…')).toHaveCount(0);
    expect(errors, `${name}: page errors`).toEqual([]);
  }

  test('People: the real family, with what Grandma calls each of them', async () => {
    const { people } = await (await page.request.get('/api/admin/people')).json();
    expect(people.length).toBeGreaterThan(3);
    await page.goto('/admin/people');
    await expect(page.getByRole('heading', { name: 'Invite someone' })).toBeVisible();
    const familyHeading = page.getByRole('heading', { name: /^Family \(\d+\)$/ });
    await expect(familyHeading).toHaveText(`Family (${people.filter((p) => p.status !== 'removed').length})`);
    for (const person of people.filter((p) => p.status !== 'removed').slice(0, 4)) {
      const card = page.locator('.person', { hasText: person.email });
      await expect(card.locator('.card-name')).toHaveText(person.name);
      await expect(card.locator('.grandma-name b')).toHaveText(person.short_name);
    }
    const pending = people.find((p) => p.status === 'pending');
    if (pending) await expect(page.locator('.person', { hasText: pending.email })).toContainText('hasn’t signed in yet');
    await expectCalm('people');
    await shoot(page, 'family-admin-people');
  });

  test('People: Ben changes what Grandma calls Mike, and the server keeps it', async () => {
    const { people } = await (await page.request.get('/api/admin/people')).json();
    const mike = people.find((p) => p.email === 'mike@example.com') ?? people.find((p) => p.status === 'active' && p.email !== ADMIN_EMAIL);
    const card = page.locator('.person', { hasText: mike.email });
    await card.getByRole('button', { name: `Change what Grandma calls ${mike.name}` }).click();
    await card.getByLabel('What Grandma calls them').fill('Uncle Mike');
    await card.getByRole('button', { name: 'Save' }).click();
    await expect(card.locator('.grandma-name')).toContainText('Grandma calls them Uncle Mike · saved');
    const after = (await (await page.request.get('/api/admin/people')).json()).people.find((p) => p.id === mike.id);
    expect(after.short_name).toBe('Uncle Mike');
    // put it back, so other specs see the demo as seeded
    const res = await page.request.patch(`/api/admin/people/${mike.id}`, { data: { short_name: mike.short_name }, headers: ORIGIN_HEADERS });
    expect(res.ok()).toBe(true);
    await expectCalm('people: short name');
  });

  test('People: Ben makes an invite and cancels it', async () => {
    await page.goto('/admin/people');
    await page.getByLabel('Name', { exact: true }).fill('Cousin Dee');
    await page.getByLabel('Email', { exact: true }).fill('dee.admin-spec@example.com');
    await page.getByLabel('Email the invite to them').uncheck();
    await page.getByRole('button', { name: 'Create invite' }).click();
    await expect(page.locator('.once-link')).toContainText('/join/');
    await expect(page.getByRole('heading', { name: 'Invite for Cousin Dee' })).toHaveCount(0); // a note title, not a heading
    await expect(page.locator('.note-title', { hasText: 'Invite for Cousin Dee' })).toBeVisible();
    const waiting = page.locator('.card-row', { hasText: 'dee.admin-spec@example.com' });
    await expect(waiting).toContainText('expires');
    await waiting.getByRole('button', { name: 'Cancel invite' }).click();
    await waiting.getByRole('button', { name: 'Tap again to cancel' }).click();
    await expect(page.locator('.card-row', { hasText: 'dee.admin-spec@example.com' })).toHaveCount(0);
    const { invites } = await (await page.request.get('/api/admin/people')).json();
    expect(invites.some((i) => i.email === 'dee.admin-spec@example.com')).toBe(false);
    await expectCalm('people: invite');
  });

  test('Uploads: the real uploads with their owners and thumbnails', async () => {
    const { items } = await (await page.request.get('/api/admin/items')).json();
    expect(items.length).toBeGreaterThan(0);
    await page.goto('/admin/uploads');
    const rows = page.locator('.card-row');
    await expect(rows.first()).toBeVisible();
    await expect(rows).toHaveCount(items.length);
    await expect(rows.first()).toContainText(items[0].user.name);
    const thumb = rows.first().locator('img.thumb');
    await expect(thumb).toHaveJSProperty('complete', true);
    expect(await thumb.evaluate((img) => img.naturalWidth)).toBeGreaterThan(0);
    await page.getByRole('button', { name: 'Hidden', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Hidden', exact: true })).toHaveAttribute('aria-pressed', 'true');
    await expectCalm('uploads');
    await shoot(page, 'family-admin-uploads');
  });

  test('The frame: the paired frames, each with when it was last seen', async () => {
    const { devices } = await (await page.request.get('/api/admin/devices')).json();
    const live = devices.filter((d) => !d.revoked_at);
    expect(live.length).toBeGreaterThan(0);
    await page.goto('/admin/frame');
    for (const d of live) {
      await expect(page.locator('.card-row', { hasText: d.name }).first()).toContainText(d.last_seen_at ? 'Last seen' : 'Not seen yet');
    }
    await expect(page.getByRole('link', { name: 'See Health' })).toBeVisible();
    await expectCalm('frame');
  });

  test('Messages: the preset messages, in order', async () => {
    const { presets } = await (await page.request.get('/api/admin/presets')).json();
    await page.goto('/admin/messages');
    await expect(page.getByRole('heading', { name: 'Messages Grandma can send' })).toBeVisible();
    for (const [i, p] of presets.entries()) await expect(page.getByLabel(`Message ${i + 1}`, { exact: true })).toHaveValue(p.text);
    const on = presets.filter((p) => p.active).length;
    await expect(page.getByRole('status').filter({ hasText: `${on} of 8 spaces used` })).toBeVisible();
    await expectCalm('messages');
  });

  test('Night hours: the saved times and zone', async () => {
    const { settings } = await (await page.request.get('/api/admin/settings')).json();
    await page.goto('/admin/night');
    await expect(page.getByLabel('Dim at')).toHaveValue(settings.night_start);
    await expect(page.getByLabel('Wake at')).toHaveValue(settings.night_end);
    await expect(page.getByText(`Times are in ${settings.timezone}.`)).toBeVisible();
    await expectCalm('night');
  });

  test('Health: a calm card from the real server', async () => {
    const health = await (await page.request.get('/api/admin/health')).json();
    await page.goto('/admin/health');
    await expect(page.getByRole('heading', { name: 'Health' })).toBeVisible();
    await expect(page.locator('[data-health="backup"]')).toContainText('Nightly backup');
    await expect(page.locator('[data-health="queue"]')).toContainText(health.queue_depth ? 'getting ready' : 'Nothing waiting');
    await expect(page.locator('[data-health="failed"]')).toContainText(health.failed_jobs ? 'couldn’t be processed' : 'None');
    await expect(page.locator('[data-health="drive"]')).toContainText(/free of [\d.]+ (GB|TB)/);
    await expect(page.locator('[data-health="worker"]')).toContainText('Working');
    await expect(page.locator('[data-health="frame"]')).toBeVisible();
    await expect(page.locator('.health')).not.toContainText(/null|NaN|undefined/);
    const { issues } = await audit(page, 'family');
    expect(issues, JSON.stringify(issues, null, 1)).toEqual([]);
    await expectCalm('health');
    await shoot(page, 'family-admin-health');
  });
});
