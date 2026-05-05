import { test as base, expect, type Page } from '@playwright/test';

/**
 * Party module smoke (Story 15.3 AC #11).
 *
 * After the 2026-04-20 Labs unification, project selection moved to a single
 * top-level picker (ProjectPicker). The Party tab renders the selected
 * project's BMAD panel + chat area — no more per-tab grid.
 */

const FAKE_USER = {
  userId: 'test-user-1',
  email: 'test@futurator.test',
  name: 'Test User',
};

const FAKE_PROJECTS = [
  {
    projectId: 'battleship',
    path: '/home/ubuntu/projects/battleship',
    bmadStatus: 'MISSING',
    expectedAgentCount: 23,
    createdAt: '2026-04-17T00:00:00Z',
    updatedAt: '2026-04-17T00:00:00Z',
  },
  {
    projectId: 'dino-chrome',
    path: '/home/ubuntu/projects/dino-chrome',
    bmadStatus: 'HEALTHY',
    bmadVersion: '6.0.0-alpha.7',
    agentCount: 23,
    expectedAgentCount: 23,
    lastInspectedAt: '2026-04-17T00:00:00Z',
    customAgentsSHA: 'deadbeef',
    createdAt: '2026-04-17T00:00:00Z',
    updatedAt: '2026-04-17T00:00:00Z',
  },
  {
    projectId: 'hello-world',
    path: '/home/ubuntu/projects/hello-world',
    bmadStatus: 'DRIFTED',
    bmadVersion: '6.0.0-alpha.7',
    agentCount: 23,
    expectedAgentCount: 23,
    lastInspectedAt: '2026-04-17T00:00:00Z',
    createdAt: '2026-04-17T00:00:00Z',
    updatedAt: '2026-04-17T00:00:00Z',
  },
];

async function seedAuth(page: Page) {
  await page.addInitScript(
    ({ user }) => {
      const expiresAt = Date.now() + 60 * 60 * 1000;
      sessionStorage.setItem(
        'futurator_tokens',
        JSON.stringify({
          accessToken: 'fake-access-token',
          refreshToken: 'fake-refresh-token',
          familyId: 'fake-family',
          tokenId: 'fake-token-id',
          expiresAt,
        }),
      );
      sessionStorage.setItem('futurator_user', JSON.stringify(user));
      window.localStorage.setItem('futurator.labs.runtimeMode', 'ec2');
      // Ensure no leftover activeAppName from a previous run.
      window.localStorage.removeItem('futurator.labs.activeAppName');
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
    if (path.endsWith('/api/party/projects') && method === 'GET') {
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ projects: FAKE_PROJECTS, expectedAgentCount: 23 }),
      });
    }
    const bootstrapMatch = path.match(/\/api\/party\/projects\/([^/]+)\/bootstrap$/);
    if (bootstrapMatch && method === 'POST') {
      return route.fulfill({
        status: 201,
        contentType: 'application/json',
        body: JSON.stringify({ jobId: 'job-xyz', projectId: bootstrapMatch[1] }),
      });
    }
    if (path.includes('/api/agent-jobs/job-xyz/events')) {
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ events: [], lastSeq: '000000' }),
      });
    }
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

test('ProjectPicker lists party projects with health chips', async ({ authedPage }) => {
  await authedPage.goto('/labs');
  // Open the unified picker.
  await authedPage.getByRole('button', { name: /Select project/ }).click();
  await expect(authedPage.getByText('battleship')).toBeVisible();
  await expect(authedPage.getByText('dino-chrome')).toBeVisible();
  await expect(authedPage.getByText('hello-world')).toBeVisible();
  await expect(authedPage.getByText('No BMAD').first()).toBeVisible();
  await expect(authedPage.getByText('Healthy').first()).toBeVisible();
  await expect(authedPage.getByText('Drifted').first()).toBeVisible();
});

test('Selecting a MISSING project shows Install BMAD in Party tab', async ({ authedPage }) => {
  await authedPage.goto('/labs');
  await authedPage.getByRole('button', { name: /Select project/ }).click();
  await authedPage.getByRole('button', { name: /battleship/ }).click();
  await authedPage.getByRole('tab', { name: 'Party' }).click();
  await expect(authedPage.getByTestId('labs-party')).toBeVisible();
  await authedPage.getByRole('button', { name: 'Install BMAD' }).click();
  await expect(authedPage.getByTestId('bootstrap-progress')).toBeVisible();
  await expect(authedPage.getByText('Bootstrap progress')).toBeVisible();
});
