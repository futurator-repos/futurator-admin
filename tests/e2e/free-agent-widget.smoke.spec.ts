import { test as base, expect, type Page } from '@playwright/test';

/**
 * Free Agent widget smoke (Story 18.4 AC #10).
 *
 * Verifies the global widget shell:
 *   - FAB visible on an authenticated page
 *   - Click opens panel with Workspace lens (default route /labs has no scope match)
 *   - Close button closes the panel
 *
 * Note: lens transitions and EC2-mode-disabled state have COMPREHENSIVE coverage
 * via vitest jsdom tests in src/components/free-agent/__tests__/widget.test.tsx
 * (21 tests). This smoke is the e2e gate that the widget mounts globally and
 * survives the real Next.js render pipeline.
 */

const FAKE_USER = {
  userId: 'test-user-1',
  email: 'test@futurator.test',
  name: 'Test User',
};

async function seedAuth(page: Page) {
  await page.addInitScript(
    ({ user }) => {
      const expiresAt = Date.now() + 60 * 60 * 1000;
      const tokens = {
        accessToken: 'fake-access-token',
        refreshToken: 'fake-refresh-token',
        familyId: 'fake-family',
        tokenId: 'fake-token-id',
        expiresAt,
      };
      // use-auth.ts reads from localStorage; the existing party tests use
      // sessionStorage which works for *their* paths but doesn't trigger
      // isAuthenticated=true in useAuthStore. We seed BOTH to maximize
      // compatibility with anything reading either.
      localStorage.setItem('futurator_tokens', JSON.stringify(tokens));
      localStorage.setItem('futurator_user', JSON.stringify(user));
      sessionStorage.setItem('futurator_tokens', JSON.stringify(tokens));
      sessionStorage.setItem('futurator_user', JSON.stringify(user));
      // EC2 mode = ec2 → FAB is enabled.
      window.localStorage.setItem('futurator.labs.runtimeMode', 'ec2');
    },
    { user: FAKE_USER },
  );
}

async function mockApi(page: Page) {
  await page.route('**/api/**', async (route) => {
    const url = new URL(route.request().url());
    const path = url.pathname;

    if (path.endsWith('/api/auth/me')) {
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(FAKE_USER),
      });
    }
    // Generic catch-all — empty success.
    return route.fulfill({ status: 200, contentType: 'application/json', body: '[]' });
  });
}

const test = base.extend<{ authedPage: Page }>({
  authedPage: async ({ page }, use) => {
    await seedAuth(page);
    await mockApi(page);
    // eslint-disable-next-line react-hooks/rules-of-hooks -- `use` is Playwright's fixture API, not a React hook
    await use(page);
  },
});

test('FAB is visible on an authenticated page', async ({ authedPage }) => {
  await authedPage.goto('/labs');
  await expect(authedPage.getByTestId('free-agent-fab')).toBeVisible();
});

test('clicking the FAB opens the panel with the Workspace lens', async ({ authedPage }) => {
  await authedPage.goto('/labs');
  await authedPage.getByTestId('free-agent-fab').click();
  await expect(authedPage.getByTestId('free-agent-panel')).toBeVisible();
  await expect(authedPage.getByTestId('free-agent-lens-label')).toContainText(
    'Assistant — Workspace',
  );
});

test('close button closes the panel and FAB reappears', async ({ authedPage }) => {
  await authedPage.goto('/labs');
  await authedPage.getByTestId('free-agent-fab').click();
  await expect(authedPage.getByTestId('free-agent-panel')).toBeVisible();
  await authedPage.getByTestId('free-agent-close').click();
  await expect(authedPage.getByTestId('free-agent-panel')).toBeHidden();
  await expect(authedPage.getByTestId('free-agent-fab')).toBeVisible();
});

test('empty thread shows the placeholder text', async ({ authedPage }) => {
  await authedPage.goto('/labs');
  await authedPage.getByTestId('free-agent-fab').click();
  await expect(authedPage.getByTestId('free-agent-thread-empty')).toContainText(
    'Send a message to start',
  );
});
