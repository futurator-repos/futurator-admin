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
// Port 3000 is the default, but other Futurator projects' dev servers often
// hold it. `PLAYWRIGHT_PORT=3020 npm run test:e2e` runs the suite beside them
// instead of timing out against someone else's app.
const PORT = process.env.PLAYWRIGHT_PORT || '3000';

export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: 'list',
  use: {
    baseURL: `http://localhost:${PORT}`,
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
    command: `npm run dev -- --port ${PORT}`,
    url: `http://localhost:${PORT}/login`,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
    stdout: 'ignore',
    stderr: 'pipe',
  },
});
