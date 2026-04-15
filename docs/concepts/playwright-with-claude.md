# Playwright with Claude — Reusable Guide

> A portable how-to for instructing Claude (Code) to write and execute browser-level
> tests with Playwright. Covers what Claude can and cannot do, how to invoke it,
> the setup needed in a new project, common patterns, and real examples.
>
> Drop this file into any project's `docs/` to standardise how you ask Claude
> to verify UI behaviour.

---

## TL;DR

- **Playwright is a local-only dev tool. It runs on your machine, never on AWS, and costs nothing.**
- Claude can launch real headless Chromium, navigate to any URL (localhost or production), click/type/scroll, assert DOM state, capture console errors and network requests, and take screenshots that Claude itself can read back.
- Two distinct modes: **(1)** persistent CI smoke suite under `tests/e2e/` (mocks the API, runs against `next dev`), and **(2)** one-off ad-hoc scripts for production verification or debugging.
- Claude **cannot** complete real OAuth flows, click email verification links, or use real social logins. For protected routes against production, give Claude a long-lived access token to inject as a Bearer header.
- **Trigger phrase that works best:** _"Use Playwright to verify [feature] works"_ or _"Add a Playwright smoke test for [feature]"_.

---

## Why Playwright (vs unit tests, vs curl)

| Layer                          | Tool                      | Catches                                                                                               |
| ------------------------------ | ------------------------- | ----------------------------------------------------------------------------------------------------- |
| Type-level                     | `tsc` / TypeScript        | Type errors, missing fields                                                                           |
| Build-level                    | `next build`              | Import errors, build-time issues                                                                      |
| Unit                           | `vitest` / `jest`         | Pure function bugs, schema validation                                                                 |
| **Browser smoke (this guide)** | **Playwright**            | **Orphaned components, hydration mismatches, runtime errors, real DOM bugs, integration regressions** |
| End-to-end                     | Playwright + real backend | Backend integration, auth flows, data persistence                                                     |

The canonical bug class Playwright catches that nothing else does: **a component file exists in the codebase, the build passes, types check, but the component is never imported anywhere and the user sees a "coming soon" placeholder.** A single click-and-look smoke test catches it instantly. We hit this bug three times in one epic on Futurator-Admin.

---

## Two Operating Modes

### Mode 1: Persistent smoke suite (`tests/e2e/`)

Lives in the repo. Runs on demand or in CI. Uses Playwright's test runner, fixtures, and assertions. Mocks the backend so tests don't need real data or auth.

**When to use:** every feature that has user-visible UI. Add 1-2 smoke tests when you build it. They become regression armour for the whole team.

**Run it:** `npm run test:e2e` (headless) or `npm run test:e2e:headed` (visible browser).

### Mode 2: One-off ad-hoc scripts

A `/tmp/something.js` file Claude writes on the fly to verify a specific deployment, debug a production issue, or capture state from a live URL. Not committed.

**When to use:** "is the deploy actually live?", "does the new feature work end-to-end against real data?", "what does the page look like in dark mode on mobile?"

**Run it:** `node /tmp/script.js` — Claude will write and run this for you.

---

## How to Invoke Claude to Use Playwright

These phrases reliably trigger me to reach for Playwright:

| Phrase                                                 | What I'll do                                    |
| ------------------------------------------------------ | ----------------------------------------------- |
| "Use Playwright to verify X"                           | One-off script if quick, otherwise add to suite |
| "Add a Playwright smoke test for X"                    | Add a `.spec.ts` to `tests/e2e/`, run it        |
| "Browser-test the new Y feature"                       | Same as above                                   |
| "Open a headless browser and check Z"                  | One-off script, paste results                   |
| "After deploying, verify visually that …"              | Production one-off after the deploy             |
| "Take a screenshot of the new modal"                   | Playwright screenshot, then I read it back      |
| "Run the smoke tests"                                  | `npm run test:e2e`                              |
| "What does admin.futurator.ai look like in dark mode?" | Set `colorScheme: 'dark'`, screenshot, read     |

**Anti-patterns** (these will get you `curl` or build checks instead of Playwright):

- "Test the deploy" — too vague, I'll default to `curl /api/health`
- "Check it works" — too vague, I'll default to build/type-check
- "Make sure it's deployed" — I'll check Lambda config, not browser

If you want browser-level verification, **say "browser" or "Playwright" or "visually" explicitly.**

---

## First-Time Setup in a New Project

Drop these files in and you're done. Total setup time: ~2 minutes.

### 1. Install

```bash
npm install --save-dev @playwright/test
npx playwright install chromium    # downloads ~92 MB to ~/Library/Caches/ms-playwright/
```

### 2. `playwright.config.ts` at the project root

```typescript
import { defineConfig, devices } from '@playwright/test';

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
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: 'npm run dev',
    url: 'http://localhost:3000', // change if your dev server uses a different path
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
    stdout: 'ignore',
    stderr: 'pipe',
  },
});
```

### 3. `tests/e2e/fixtures.ts` (auth bypass + API mocking)

This is the killer pattern. It pre-seeds storage with fake auth tokens AND intercepts every `/api/*` call so tests run with no backend.

```typescript
import { test as base, expect, type Page } from '@playwright/test';

export const FAKE_USER = {
  userId: 'test-user-1',
  email: 'test@example.test',
  name: 'Test User',
};

// Replace this with your project's seed data
export const FAKE_DATA = [{ id: '1', name: 'Sample Item', status: 'active' }];

async function seedAuth(page: Page) {
  // CHANGE: match your project's auth-store sessionStorage/localStorage keys
  await page.addInitScript(
    ({ user }) => {
      const expiresAt = Date.now() + 60 * 60 * 1000;
      sessionStorage.setItem(
        'app_tokens',
        JSON.stringify({
          accessToken: 'fake-access-token',
          refreshToken: 'fake-refresh-token',
          expiresAt,
        }),
      );
      sessionStorage.setItem('app_user', JSON.stringify(user));
    },
    { user: FAKE_USER },
  );
}

async function mockApi(page: Page) {
  await page.route('**/api/**', async (route) => {
    const url = new URL(route.request().url());
    const path = url.pathname;
    const method = route.request().method();

    if (path.endsWith('/api/auth/me')) {
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(FAKE_USER),
      });
    }
    if (path.endsWith('/api/items') && method === 'GET') {
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(FAKE_DATA),
      });
    }
    // Default: empty array so unrelated panels don't crash
    return route.fulfill({ status: 200, contentType: 'application/json', body: '[]' });
  });
}

export const test = base.extend<{ authedPage: Page }>({
  authedPage: async ({ page }, use) => {
    await seedAuth(page);
    await mockApi(page);
    await use(page);
  },
});

export { expect };
```

### 4. First smoke test `tests/e2e/smoke.spec.ts`

```typescript
import { test, expect } from './fixtures';

test('home page loads and shows seeded data', async ({ authedPage }) => {
  await authedPage.goto('/');
  await expect(authedPage.getByText('Sample Item')).toBeVisible();
});
```

### 5. `package.json` scripts

```json
{
  "scripts": {
    "test:e2e": "playwright test",
    "test:e2e:headed": "playwright test --headed",
    "test:e2e:debug": "playwright test --debug"
  }
}
```

### 6. CRITICAL: exclude `.spec.ts` from vitest

If you use vitest for unit tests, make sure its `include` pattern only matches `.test.ts`, NOT `.spec.ts`, so it doesn't try to run e2e files:

```typescript
// vitest.config.ts
export default defineConfig({
  test: {
    include: ['**/*.test.{ts,tsx}'], // .test only — NOT .spec
    // ...
  },
});
```

Use `.test.ts` for vitest unit tests, `.spec.ts` for Playwright e2e tests. This is a convention worth standardising across all your projects.

### 7. `.gitignore` additions

```
test-results/
playwright-report/
playwright/.cache/
```

### 8. Verify

```bash
npm run test:e2e
# Should print:
# Running 1 test using 1 worker
#   ✓  1 [chromium] › tests/e2e/smoke.spec.ts:3:5 › home page loads (...)
#   1 passed (Xs)
```

---

## Capabilities

### Navigation

```typescript
await page.goto('/'); // relative to baseURL
await page.goto('https://prod.example.com/page'); // absolute
await page.goBack();
await page.reload();
await page.waitForURL('**/dashboard');
await page.waitForLoadState('networkidle');
```

### Locators (the modern API — prefer these)

```typescript
// Best: by ARIA role + accessible name
await page.getByRole('button', { name: 'Save' }).click();
await page.getByRole('textbox', { name: 'Email' }).fill('a@b.c');

// Good: by visible text or label
await page.getByText('Welcome').isVisible();
await page.getByLabel('Password').fill('hunter2');
await page.getByPlaceholder('Search...').fill('foo');

// OK: by test-id (add data-testid in your code)
await page.getByTestId('user-menu').click();

// Last resort: CSS selector
await page.locator('[data-slot="select-trigger"]').nth(1).click();

// Filter for specific items
await page.locator('input').filter({ hasText: 'Email' });
await page.locator('input[value="alpha"]').first();
```

**Selector preference order:** `getByRole` > `getByLabel` > `getByText` > `getByPlaceholder` > `getByTestId` > CSS. Higher up the list = more accessible-by-default = less brittle to refactors.

### Interactions

```typescript
await page.getByRole('button', { name: 'Open' }).click();
await page.getByRole('textbox').fill('hello');
await page.getByRole('textbox').type('hello', { delay: 50 }); // simulate typing
await page.getByRole('checkbox').check();
await page.getByRole('checkbox').uncheck();
await page.getByRole('combobox').selectOption('option-value');
await page.getByText('Drag me').dragTo(page.getByText('Drop here'));
await page.keyboard.press('Escape');
await page.keyboard.press('Control+S');
await page.mouse.move(100, 200);
await page.mouse.click(100, 200);
```

### Assertions (auto-retrying, no `await sleep` needed)

```typescript
await expect(page.getByText('Saved')).toBeVisible();
await expect(page.getByText('Error')).toHaveCount(0);
await expect(page.getByRole('textbox')).toHaveValue('foo');
await expect(page.getByRole('button')).toBeEnabled();
await expect(page.getByRole('button')).toBeDisabled();
await expect(page).toHaveURL('/dashboard');
await expect(page).toHaveTitle(/Admin/);
await expect(page.locator('img').first()).toHaveAttribute('alt', 'Logo');
```

All `expect(locator).toXxx()` calls auto-retry until either the assertion passes or the timeout fires. **Never use `await page.waitForTimeout(500)` to "let things settle"** — it's flaky. Use a real assertion that retries.

### Console + page errors

```typescript
const errors: string[] = [];
page.on('pageerror', (e) => errors.push(`PAGEERROR: ${e.message}`));
page.on('console', (msg) => {
  if (msg.type() === 'error') errors.push(`CONSOLE: ${msg.text()}`);
});

await page.goto('/');
await page.waitForLoadState('networkidle');

expect(errors).toHaveLength(0); // fail the test if any JS errors fired
```

This is how I caught a real React 19 "setState during render" warning in `filter-bar.tsx` while writing the smoke tests for this project — Playwright surfaced it from the dev server console output.

### Network capture

```typescript
const requests: string[] = [];
page.on('request', (req) => requests.push(`${req.method()} ${req.url()}`));

await page.goto('/');

expect(requests).toContain('GET https://api.example.com/projects');
```

### Auth bypass via storage seeding

The reliable pattern — pre-seed BEFORE the page navigates so React reads it on first render:

```typescript
await page.addInitScript(() => {
  sessionStorage.setItem(
    'tokens',
    JSON.stringify({
      accessToken: 'fake-token',
      expiresAt: Date.now() + 60 * 60 * 1000,
    }),
  );
  sessionStorage.setItem('user', JSON.stringify({ id: '1', name: 'Test' }));
});
await page.goto('/dashboard'); // auth-guard sees seeded state, doesn't redirect
```

Use `addInitScript` (NOT `evaluate` after `goto`) so it runs before any page script.

### API mocking with `page.route()`

```typescript
// Catch-all
await page.route('**/api/**', async (route) => {
  const url = new URL(route.request().url());

  if (url.pathname === '/api/projects') {
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify([{ id: '1', name: 'Mock Project' }]),
    });
  }

  // Default: empty array
  return route.fulfill({ status: 200, contentType: 'application/json', body: '[]' });
});

// Per-call: simulate failure
await page.route('**/api/save', (route) => {
  route.fulfill({ status: 500, body: 'Internal Server Error' });
});
```

### Screenshots (and Claude reading them)

```typescript
await page.screenshot({ path: '/tmp/full-page.png', fullPage: true });
await page.locator('.modal').screenshot({ path: '/tmp/modal.png' });
```

After Playwright saves the screenshot, **Claude can use the `Read` tool on the PNG file** to actually look at it. So when you say "screenshot the new modal in dark mode and tell me if the badges look right", I will:

1. Write a script that opens the page in dark mode
2. Screenshot the modal to `/tmp/modal-dark.png`
3. Run the script
4. Use `Read` on `/tmp/modal-dark.png` to view the image
5. Describe what I see, flag visual issues

This works because Claude Code is multimodal — image files are first-class.

### Multiple viewports / dark mode emulation

```typescript
import { chromium } from 'playwright';

const browser = await chromium.launch();

// Dark mode + iPhone viewport
const context = await browser.newContext({
  colorScheme: 'dark',
  viewport: { width: 390, height: 844 },
  deviceScaleFactor: 3,
});

const page = await context.newPage();
await page.goto('https://admin.example.com');
await page.screenshot({ path: '/tmp/iphone-dark.png' });
```

Test the same flow at desktop (`1280x800`), tablet (`768x1024`), mobile (`390x844`) by parameterising `viewport`.

### Video recording (Claude can't watch but useful for human review)

```typescript
// In playwright.config.ts
use: {
  video: 'retain-on-failure',  // or 'on' for always
}
```

Failed test videos land in `test-results/`. I can't watch a video, but I can read screenshots, console logs, and network HARs.

### Tracing (best for debugging a flaky test)

```typescript
// In playwright.config.ts
use: {
  trace: 'on-first-retry',  // or 'on'
}
```

Then `npx playwright show-trace test-results/.../trace.zip` opens an interactive timeline with screenshots, network, console, source mapping.

---

## Limitations (Be Honest About These)

### Things I genuinely cannot do

| Limitation                                  | Why                                                            | Workaround                                                                                                |
| ------------------------------------------- | -------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| **Real Google/Microsoft OAuth login**       | I'm not a person; can't click "Allow" on a real consent screen | Provide a long-lived access token. Inject via `page.setExtraHTTPHeaders({ Authorization: 'Bearer ...' })` |
| **Email/SMS verification clicks**           | Can't read your inbox                                          | Use a project-side test mode that bypasses verification, or provide me a test inbox                       |
| **Captchas**                                | Designed to defeat bots                                        | Use captcha-bypass test keys (Google reCAPTCHA test keys, hCaptcha test mode, etc.)                       |
| **Real credit card payments**               | Don't even try                                                 | Stripe/etc test mode                                                                                      |
| **Watch a video and tell you what happens** | I can't process video frames                                   | Use screenshots at key moments instead                                                                    |
| **Test on real iPhone/Android**             | Playwright is web-only; no native iOS/Android                  | Use Playwright's mobile emulation (`devices['iPhone 13']`) — close enough for layout                      |
| **Test things behind a VPN/firewall**       | Can only hit URLs from this machine's network                  | Run me from a machine that's already connected                                                            |

### Things that are technically possible but flaky

- **Pixel-perfect visual diffing.** `expect(page).toHaveScreenshot()` compares pixels against a baseline. Works if your environment is identical (same OS, same fonts, same scaling). Across machines or after a font upgrade, it produces noise. **Recommended approach: assert on text and structure, not pixels.**
- **Tests that depend on external API uptime.** Mock by default. Only hit real APIs in a separate "integration" suite.
- **Tests that depend on system clock.** Use `page.clock.install()` to fake time.

### Things to avoid

- **`await page.waitForTimeout(N)` as a synchronization mechanism.** Use auto-retrying assertions instead. Sleep is the #1 source of flaky tests.
- **Over-specific selectors.** `page.locator('div > div > span:nth-child(3)')` breaks on every refactor. Use `getByRole`.
- **Snapshot tests of large HTML.** Maintenance hell. Test specific elements.
- **Sharing state between tests.** Each test should be independent. Use fixtures for setup.

---

## Common Patterns

### Pattern: Production smoke test (one-off script)

```javascript
// /tmp/prod-smoke.js
const { chromium } = require('playwright');

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage();

  const errors = [];
  page.on('pageerror', (e) => errors.push(`PAGEERROR: ${e.message}`));
  page.on('console', (msg) => {
    if (msg.type() === 'error') errors.push(`CONSOLE: ${msg.text()}`);
  });

  const resp = await page.goto('https://example.com', { waitUntil: 'networkidle', timeout: 30000 });
  console.log('STATUS:', resp.status());
  console.log('TITLE:', await page.title());

  // Assertions
  const heroVisible = await page.getByRole('heading', { name: /welcome/i }).isVisible();
  console.log('HERO VISIBLE:', heroVisible);

  console.log('ERRORS:', errors.length === 0 ? 'NONE' : errors.join('\n'));

  await page.screenshot({ path: '/tmp/prod-smoke.png', fullPage: true });
  console.log('SCREENSHOT: /tmp/prod-smoke.png');

  await browser.close();
})();
```

Run with `node /tmp/prod-smoke.js`. Then I `Read` the screenshot to look at it.

### Pattern: Authenticated production smoke (with real token)

```javascript
const { chromium } = require('playwright');

(async () => {
  const browser = await chromium.launch();
  const context = await browser.newContext({
    extraHTTPHeaders: {
      Authorization: `Bearer ${process.env.TEST_TOKEN}`,
    },
  });
  const page = await context.newPage();

  // Pre-seed sessionStorage for client-side auth check too
  await page.addInitScript((token) => {
    sessionStorage.setItem(
      'app_tokens',
      JSON.stringify({
        accessToken: token,
        expiresAt: Date.now() + 3600_000,
      }),
    );
  }, process.env.TEST_TOKEN);

  await page.goto('https://admin.example.com/protected');
  // ... rest of test

  await browser.close();
})();
```

You give me the token in a message: _"Here's a test token: `eyJhb...` — use it to verify the modal opens against production."_ I'll set `TEST_TOKEN` and run.

### Pattern: Multi-viewport screenshot battery

```typescript
import { test } from '@playwright/test';

const VIEWPORTS = [
  { name: 'desktop', width: 1280, height: 800 },
  { name: 'tablet', width: 768, height: 1024 },
  { name: 'mobile', width: 390, height: 844 },
];

for (const vp of VIEWPORTS) {
  for (const scheme of ['light', 'dark'] as const) {
    test(`renders ${vp.name} ${scheme}`, async ({ browser }) => {
      const context = await browser.newContext({
        viewport: { width: vp.width, height: vp.height },
        colorScheme: scheme,
      });
      const page = await context.newPage();
      await page.goto('/');
      await page.screenshot({
        path: `/tmp/${vp.name}-${scheme}.png`,
        fullPage: true,
      });
    });
  }
}
```

Run once, get 6 screenshots, ask Claude to look at all of them and report any visual issues.

### Pattern: Wait for network idle then assert

```typescript
await page.goto('/dashboard', { waitUntil: 'networkidle' });
await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible();
```

`networkidle` waits until there are no in-flight requests for 500ms. Good for SPA dashboards that fetch data on mount.

### Pattern: Test a flow that requires form submission and post-save state

```typescript
test('save flow updates the list', async ({ authedPage }) => {
  await authedPage.goto('/items');

  // Open modal
  await authedPage.getByRole('button', { name: 'Edit Sample Item' }).click();

  // Fill form
  await authedPage.getByLabel('Name').fill('Renamed Item');

  // Mock the PUT response
  await authedPage.route('**/api/items/1', (route) => {
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ id: '1', name: 'Renamed Item' }),
    });
  });

  // Submit
  await authedPage.getByRole('button', { name: 'Save Changes' }).click();

  // Assert success state
  await expect(authedPage.getByText('Saved at')).toBeVisible();
  await expect(authedPage.getByText('Renamed Item')).toBeVisible();
});
```

---

## Best Practices

### 1. Co-locate tests with the feature

Don't put all tests in one mega-file. One `.spec.ts` per feature area: `modal-smoke.spec.ts`, `filters.spec.ts`, `auth-flow.spec.ts`. Faster to find, easier to delete when the feature is removed.

### 2. Tests should be readable like prose

```typescript
// Good
test('clicking edit pencil opens modal with project data', async ({ authedPage }) => {
  await authedPage.goto('/projects');
  await authedPage.getByRole('button', { name: 'Edit Test Alpha' }).click();
  await expect(authedPage.getByText('Edit Project: Test Alpha')).toBeVisible();
});

// Bad
test('test1', async ({ page }) => {
  await page.goto('/x');
  await page.click('.btn-3');
  await page.waitForTimeout(2000);
  expect(await page.locator('.m').count()).toBeGreaterThan(0);
});
```

### 3. One assertion per concern

```typescript
// Good — each line is an independent claim
await expect(modal).toBeVisible();
await expect(modal.getByRole('heading')).toHaveText('Edit Project');
await expect(modal.getByLabel('Name')).toHaveValue('Alpha');

// Bad — single mega-assertion
expect(await modal.evaluate(/* huge JS function */)).toBe('expected');
```

### 4. Use fixtures for setup, not `beforeEach`

The fixture pattern (`test.extend({ authedPage: ... })`) makes test files declare their dependencies in their function signatures. Way cleaner than `beforeEach` chains.

### 5. Mock at the boundary, not internally

Mock the network (`page.route`), not internal modules. Tests stay decoupled from your implementation.

### 6. Run the tests yourself before pushing

`npm run test:e2e` is fast. Don't rely on CI to find failures.

### 7. Keep the test data realistic

Test fixtures should mirror real data shapes. If your API returns `{ projectId, descriptions: { headline, brief, ... } }`, the mock should too. Otherwise tests pass against fake shapes and fail against real ones.

---

## Real Examples From Futurator-Admin

### Example 1: Modal smoke (catches orphaned components)

```typescript
test('project edit modal renders every section without placeholders', async ({ authedPage }) => {
  await authedPage.goto('/projects');

  // List rendered
  await expect(authedPage.getByText('Test Project Alpha')).toBeVisible();

  // Open modal
  await authedPage.getByRole('button', { name: 'Edit Test Project Alpha' }).click();
  await expect(authedPage.getByText('Edit Project: Test Project Alpha')).toBeVisible();

  // Identity section (open by default) — Name input present
  await expect(authedPage.getByPlaceholder('Project name')).toBeVisible();

  // Descriptions section (open by default) — seeded headline visible
  await expect(authedPage.locator('input[value="Alpha headline"]')).toBeVisible();

  // Features section: expand and verify FeatureEditor (NOT placeholder)
  await authedPage.getByRole('button', { name: /Features & Services \(\d+\)/ }).click();
  await expect(authedPage.getByText('Feature editor coming soon.')).toHaveCount(0);
  await expect(authedPage.locator('input[value="Existing feature"]')).toBeVisible();
  await expect(authedPage.getByRole('button', { name: /Add Feature/ })).toBeVisible();

  // Media section: expand and verify MediaManager (NOT placeholder)
  await authedPage.getByRole('button', { name: /^Media \(\d+ of 6\)/ }).click();
  await expect(authedPage.getByText('Media management coming soon.')).toHaveCount(0);
  await expect(authedPage.getByText('Add media')).toBeVisible();

  // Team section
  await authedPage.getByRole('button', { name: /^Team \(\d+\)/ }).click();
  await expect(authedPage.getByText('alice@test')).toBeVisible();
});
```

This test would have caught the bug in three different stories where a component was built but never wired into the modal.

### Example 2: Multi-select dropdown behaviour

```typescript
test('status filter is multi-select', async ({ authedPage }) => {
  await authedPage.goto('/projects');
  await expect(authedPage.getByText('Test Project Alpha')).toBeVisible();

  // Open the multi-select
  await authedPage.getByText('Status: All').click();

  // base-ui Menu renders checkbox items with role="menuitemcheckbox"
  await expect(authedPage.getByRole('menuitemcheckbox', { name: 'Active' })).toBeVisible();

  // Tick two — menu should NOT close (closeOnClick=false)
  await authedPage.getByRole('menuitemcheckbox', { name: 'Active' }).click();
  await authedPage.getByRole('menuitemcheckbox', { name: 'Planning' }).click();

  // Trigger label adapts
  await expect(authedPage.getByText('Status: 2 selected')).toBeVisible();
});
```

### Example 3: Production smoke against live homepage (one-off)

```javascript
// /tmp/futurator-smoke.js
const { chromium } = require('playwright');

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(`PAGEERROR: ${e.message}`));
  page.on('console', (msg) => {
    if (msg.type() === 'error') errors.push(`CONSOLE: ${msg.text()}`);
  });

  const resp = await page.goto('https://futurator.ai/futurator.html', {
    waitUntil: 'networkidle',
    timeout: 30000,
  });
  console.log('STATUS:', resp.status());

  await page.waitForTimeout(2000); // wait for dynamic JS to rebuild wheel

  const wheelCount = await page.locator('.wheel-item').count();
  const firstText =
    wheelCount > 0 ? await page.locator('.wheel-item').first().textContent() : '(none)';

  console.log('WHEEL ITEMS:', wheelCount);
  console.log('FIRST WHEEL ITEM:', firstText);
  console.log('ERRORS:', errors.length === 0 ? 'NONE' : errors.join('\n'));

  await browser.close();
})();
```

Output that confirmed Story 14-3 worked end-to-end:

```
STATUS: 200
WHEEL ITEMS: 1
FIRST WHEEL ITEM: Projects Coming Soon
ERRORS: CONSOLE: Failed to load resource: 404
```

The 404 was the expected miss on `/data/projects.json` (no published projects yet), correctly handled by the fallback.

---

## CI Integration (GitHub Actions)

```yaml
# .github/workflows/test.yml
name: Test
on: [pull_request]
jobs:
  e2e:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: '22', cache: 'npm' }
      - run: npm ci
      - run: npx playwright install --with-deps chromium
      - run: npm run build
      - run: npm run test:e2e
      - if: failure()
        uses: actions/upload-artifact@v4
        with:
          name: playwright-report
          path: |
            playwright-report/
            test-results/
          retention-days: 7
```

The `--with-deps` flag installs Linux system libraries Chromium needs. Playwright's report and trace files are uploaded on failure for post-mortem.

---

## Troubleshooting

### "TypeError: page.getByDisplayValue is not a function"

`getByDisplayValue` is a `@testing-library/dom` API, not Playwright. To match by an input's value, use:

```typescript
await expect(page.locator('input[value="alpha"]')).toBeVisible();
```

### "TimeoutError: locator.click: Timeout exceeded waiting for getByText('Foo')"

Element doesn't exist or isn't visible. Debug:

```typescript
await page.pause(); // opens Playwright Inspector — interactive debugger
```

Or just `console.log(await page.content())` to see the full HTML.

### Tests pass locally but fail in CI

Common causes:

1. **Race conditions:** add an explicit `expect(...).toBeVisible()` instead of `waitForTimeout()`.
2. **Different viewport:** explicitly set `viewport` in the project config.
3. **Different fonts:** install fonts in CI (`fonts-noto-color-emoji` etc.) or use a locked-down screenshot threshold.
4. **Time zones:** set `TZ=UTC` in CI env.

### "Cannot update a component while rendering a different component" warning

This is a real React 19 bug, not a Playwright bug. The dev server prints it to stdout, Playwright surfaces it. **Fix the React code.** I caught one in this project's `filter-bar.tsx` where a `useMemo` was calling a parent's `setState` synchronously inside the memo body — moved to a `useEffect`.

### "Stage not found" / port already in use

```bash
lsof -ti:3000 | xargs -r kill -9
```

Add to your test scripts to clean up stale dev servers.

### Auth bypass not working

Check that you used `addInitScript` (runs before page scripts), NOT `page.evaluate(...)` after `page.goto()`. The latter runs after React has already mounted and read storage.

### "Cannot find module 'playwright'" in /tmp/script.js

When writing one-off scripts, point at the project's node_modules:

```javascript
const { chromium } = require('/Users/you/project/node_modules/playwright');
```

---

## Cost and Safety

- **Local-only.** Playwright runs on your machine. No AWS, no cloud, no cost.
- **The Chromium binary** lives in `~/Library/Caches/ms-playwright/` (~92 MB). One-time download.
- **No deploys triggered.** Tests do not call `sst deploy` or any deploy command. They are read-only against external services unless your test explicitly POSTs.
- **Production testing is safe** _if_ your test only navigates and reads. Don't write Playwright tests that POST/PUT/DELETE against production unless you've staged a sandboxed test account.
- **No data leaves your machine** unless your test fetches from a remote URL (which it would do regardless of Playwright).

---

## Quick Reference Card

```bash
# Setup (one-time per project)
npm install --save-dev @playwright/test
npx playwright install chromium

# Run all tests (headless)
npm run test:e2e

# Run with visible browser (great for development)
npm run test:e2e:headed

# Run a single test file
npx playwright test tests/e2e/smoke.spec.ts

# Run a single test by name
npx playwright test -g "modal opens"

# Debug interactively (pauses, lets you step)
npx playwright test --debug

# Update snapshots after intentional UI change
npx playwright test --update-snapshots

# View the last test report
npx playwright show-report
```

---

## How To Ask Claude: A Cheat Sheet

| You want                           | Say this                                                                                                                                            |
| ---------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| Add a smoke test for a new feature | "Add a Playwright smoke test that verifies [feature] — the test should [specific behaviour]."                                                       |
| Verify a deploy worked             | "After deploying, run a Playwright smoke against https://example.com and report what you see."                                                      |
| Catch a bug visually               | "Open the new modal in Playwright, screenshot it in dark mode, and tell me if anything looks off."                                                  |
| Test against real production data  | "Here's a test access token: `xxx`. Use Playwright to hit admin.example.com/dashboard and confirm the chart renders."                               |
| Debug a flaky test                 | "The test `xxx.spec.ts` is flaky. Run it 5 times, capture screenshots on failure, and figure out what's racing."                                    |
| Run the existing suite             | "Run the smoke tests."                                                                                                                              |
| Check responsive behaviour         | "Use Playwright to render the dashboard at desktop, tablet, and mobile widths in both light and dark mode. Screenshot each. Tell me what's broken." |
| Catch hydration warnings           | "Open the home page in Playwright, capture all console errors, and report any React warnings."                                                      |

---

_This guide is intentionally project-agnostic. The setup files assume Next.js + a sessionStorage-based auth pattern, but the principles transfer to any web stack. Adapt the fixture's storage keys and API mock paths to match your project._

_Last updated: 2026-04-07 — based on real usage in Futurator-Admin_
