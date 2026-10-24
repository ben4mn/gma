// End-to-end tests against the real app and worker. Run them through run.sh,
// which starts both on 127.0.0.1:8787 with throwaway data and exports E2E_*.
// Playwright's bundled headless shell only: no `channel`, so never Google Chrome.
import { defineConfig } from '@playwright/test';

const tmp = process.env.E2E_TMP ?? '/tmp/gma-e2e-results';

export default defineConfig({
  testDir: '.',
  testMatch: /.*\.spec\.js$/,
  workers: 1,
  fullyParallel: false,
  timeout: 120_000,
  expect: { timeout: 15_000 },
  outputDir: `${tmp}/results`,
  reporter: [['list']],
  use: {
    baseURL: process.env.E2E_BASE_URL ?? 'http://localhost:8787',
    browserName: 'chromium',
    headless: true,
    trace: 'retain-on-failure',
    // The frame and the family app must never reach the internet.
    serviceWorkers: 'allow',
  },
});
