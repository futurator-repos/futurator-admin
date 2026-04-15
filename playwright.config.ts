import { defineConfig, devices } from '@playwright/test';

/**
 * Playwright config for futurator-admin smoke tests.
 *
 * The tests run against a local `next dev` server. They never hit the real
 * Identity Broker or AWS — auth is pre-seeded into sessionStorage and all
 * /api/* routes are mocked via `page.route()` per-test.
 *
 * The smoke suite is small by design: it exists to catch the
 * "orphaned-component" class of bug (e.g. story 12-1, 13-2, 13-3 where a new
 * component was built but never imported into the modal). It is NOT a
 * comprehensive interaction test suite.
 */
export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: 'list',
  use: {
    baseURL: 'http://localhost:3000',
    trace: 'on-first-retry',
    actionTimeout: 5_000,
    navigationTimeout: 30_000,
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
  webServer: {
    command: 'npm run dev',
    url: 'http://localhost:3000/login',
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
    stdout: 'ignore',
    stderr: 'pipe',
  },
});
