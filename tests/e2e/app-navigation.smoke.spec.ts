import { test as base, expect, type Page } from '@playwright/test';
import { FAKE_USER } from './fixtures';

/**
 * App/Plan v1 — App → Plan navigation smoke (Story 7.4).
 *
 * Exercises the new nested-route flow:
 *   /labs (Apps tab) → click an App card → /labs/[appId]
 *     → click a Plan node → /labs/[appId]/plans/[planId]
 *   → breadcrumb back to App detail → breadcrumb back to Apps grid.
 *
 * Auth pre-seeded; all /api/* routes mocked. Independent of party.smoke.spec.ts.
 */

const FAKE_APP = {
  appId: 'dino3',
  displayName: 'Dino Runner v3',
  icon: '🦖',
  workingDir: '/home/ubuntu/projects/dino3',
  executionMode: 'orchestrator',
  currentlyDeployedPlanId: 'plan_dino3_001',
  deployJobIds: ['job_dep_001'],
  workingTreeStatus: 'clean',
  createdAt: '2026-04-22T00:00:00.000Z',
  updatedAt: '2026-04-25T00:00:00.000Z',
};

const FAKE_PLAN = {
  planId: 'plan_dino3_001',
  appId: 'dino3',
  kind: 'initial',
  iterationLabel: 'v1.0 — first build',
  intent: 'Build the first version of dino3',
  description: '',
  status: 'delivered',
  epicIds: [],
  workingDir: '/home/ubuntu/projects/dino3',
  executionMode: 'orchestrator',
  totalCostUsd: 0,
  totalStories: 0,
  doneStories: 0,
  createdAt: '2026-04-22T00:00:00.000Z',
  updatedAt: '2026-04-25T00:00:00.000Z',
  createdBy: 'tester',
  name: 'dino3',
  displayName: 'dino3 v1',
};

async function seedAuth(page: Page) {
  await page.addInitScript(
    ({ user }) => {
      const expiresAt = Date.now() + 60 * 60 * 1000;
      sessionStorage.setItem(
        'futurator_tokens',
        JSON.stringify({
          accessToken: 'fake',
          refreshToken: 'fake',
          familyId: 'fake',
          tokenId: 'fake',
          expiresAt,
        }),
      );
      sessionStorage.setItem('futurator_user', JSON.stringify(user));
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

    if (path.endsWith('/api/apps')) {
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          apps: [
            {
              ...FAKE_APP,
              planCount: 1,
              currentlyLiveLabel: 'v1.0 — first build',
              derivedStatus: 'live',
            },
          ],
        }),
      });
    }

    if (path === '/api/apps/dino3') {
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          app: FAKE_APP,
          plans: [FAKE_PLAN],
          activePlan: null,
          recentDeploys: [],
        }),
      });
    }

    if (path.startsWith('/api/plans/plan_dino3_001')) {
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ ...FAKE_PLAN, epics: [] }),
      });
    }

    return route.fulfill({ status: 200, contentType: 'application/json', body: '[]' });
  });
}

const test = base.extend<{ authedPage: Page }>({
  authedPage: async ({ page }, use) => {
    await seedAuth(page);
    await mockApi(page);
    // eslint-disable-next-line react-hooks/rules-of-hooks
    await use(page);
  },
});

test('navigates Apps grid → App detail → Plan detail and back via breadcrumb', async ({
  authedPage,
}) => {
  // 1. Land on /labs and switch to the Apps tab.
  await authedPage.goto('/labs');
  await authedPage.getByRole('tab', { name: 'Apps' }).click();

  // 2. The dino3 App card renders.
  await expect(authedPage.getByText('Dino Runner v3')).toBeVisible();

  // 3. Click the App card → land on /labs/dino3.
  await authedPage.getByText('Dino Runner v3').click();
  await expect(authedPage).toHaveURL(/\/labs\/dino3$/);

  // 4. Plan timeline renders with the seeded Plan.
  await expect(authedPage.getByText('Plan Timeline')).toBeVisible();
  await expect(authedPage.getByText('v1.0 — first build')).toBeVisible();

  // 5. Click the Plan node → land on /labs/dino3/plans/plan_dino3_001.
  await authedPage.getByText('v1.0 — first build').first().click();
  await expect(authedPage).toHaveURL(/\/labs\/dino3\/plans\/plan_dino3_001$/);

  // 6. Breadcrumb shows the App name and is clickable.
  await expect(authedPage.getByLabel('Breadcrumb')).toBeVisible();
  await authedPage.getByRole('link', { name: /Dino Runner v3/ }).click();
  await expect(authedPage).toHaveURL(/\/labs\/dino3$/);
});
