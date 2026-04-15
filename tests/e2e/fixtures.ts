import { test as base, expect, type Page } from '@playwright/test';

/**
 * Test fixture that pre-seeds a fake auth state into sessionStorage and
 * registers route handlers that intercept all /api/* calls with canned data.
 *
 * Use `authedPage` instead of `page` whenever the test needs to be inside the
 * authenticated app shell. The fixture must be applied BEFORE the first
 * navigation, since the auth-store reads sessionStorage during its first
 * render.
 */

export const FAKE_USER = {
  userId: 'test-user-1',
  email: 'test@futurator.test',
  name: 'Test User',
};

export const FAKE_PROJECTS = [
  {
    projectId: 'test-project-1',
    name: 'Test Project Alpha',
    status: 'active' as const,
    category: 'personal' as const,
    descriptions: {
      headline: 'Alpha headline',
      brief: 'Alpha brief',
      summary: 'Alpha summary',
      full: '',
      aiContext: '',
      homepageFlags: { headline: true, brief: true, summary: false },
    },
    media: [],
    features: [
      {
        id: 'feat-1',
        name: 'Existing feature',
        status: 'active' as const,
        awsServices: ['Lambda', 'S3'],
        aiProviders: ['Anthropic'],
        integrations: ['Slack'],
      },
    ],
    awsServices: ['Lambda'],
    team: ['alice@test'],
    publishedToHomepage: true,
    homepageOrder: 0,
    budget: { monthlyLimit: 100 },
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-04-07T00:00:00Z',
  },
  {
    projectId: 'test-project-2',
    name: 'Test Project Beta',
    status: 'planning' as const,
    category: 'joint-venture' as const,
    descriptions: {
      headline: '',
      brief: 'Beta brief',
      summary: '',
      full: '',
      aiContext: '',
      homepageFlags: { headline: false, brief: false, summary: false },
    },
    media: [],
    features: [],
    awsServices: [],
    team: [],
    publishedToHomepage: false,
    homepageOrder: 0,
    budget: { monthlyLimit: 50 },
    createdAt: '2026-02-01T00:00:00Z',
    updatedAt: '2026-03-01T00:00:00Z',
  },
];

async function seedAuth(page: Page) {
  // Pre-seed sessionStorage so the auth-guard does not bounce us to /login.
  // The auth-store reads these keys on first render via `useAuth()`.
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
    },
    { user: FAKE_USER },
  );
}

async function mockApi(page: Page) {
  // Catch-all for all API calls. Returns canned responses based on path.
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
    if (path.endsWith('/api/projects')) {
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(FAKE_PROJECTS),
      });
    }
    const projectMatch = path.match(/\/api\/projects\/([^/]+)$/);
    if (projectMatch && method === 'GET') {
      const project =
        FAKE_PROJECTS.find((p) => p.projectId === projectMatch[1]) || FAKE_PROJECTS[0];
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(project),
      });
    }
    if (projectMatch && method === 'PUT') {
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(FAKE_PROJECTS[0]),
      });
    }
    if (path.includes('/upload-url')) {
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          uploadUrl: 'https://example.invalid/fake-upload',
          publicUrl: 'https://futurator.ai/media/test/fake.png',
          key: 'media/test/fake.png',
        }),
      });
    }
    // Default: empty array / object so charts and unrelated panels don't crash.
    return route.fulfill({ status: 200, contentType: 'application/json', body: '[]' });
  });
}

export const test = base.extend<{ authedPage: Page }>({
  authedPage: async ({ page }, use) => {
    await seedAuth(page);
    await mockApi(page);
    // eslint-disable-next-line react-hooks/rules-of-hooks -- `use` is Playwright's fixture API, not a React hook
    await use(page);
  },
});

export { expect };
