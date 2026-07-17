import { test as base, expect, type Page } from '@playwright/test';

/**
 * Servers module smoke (Task 24, docs/superpowers/plans/2026-07-16-servers-module.md).
 *
 * Exercises /development/servers/: Fleet tab renders both seeded server
 * cards with their status badges, then the Dispatch Policy tab renders the
 * mode selector — the canonical orphaned-component regression check (mirrors
 * modal-smoke.spec.ts: assert the real component renders, not a "coming
 * soon" placeholder), plus a console-error collector so a component that
 * throws during mount fails the test even if the DOM happens to look right.
 *
 * Auth pre-seeded in localStorage + sessionStorage; all /api/* routes mocked
 * via `page.route()` — never hits the real Identity Broker or AWS.
 */

const FAKE_USER = {
  userId: 'test-user-1',
  email: 'test@futurator.test',
  name: 'Test User',
};

const FAKE_SERVERS = [
  {
    serverId: 'srv_hetzner_1',
    name: 'hetzner-fsn-1',
    provider: 'hetzner',
    serviceType: 'vm',
    region: 'fsn1',
    size: 'cax11',
    arch: 'arm64',
    status: 'ACTIVE',
    enabled: true,
    maxConcurrent: 2,
    costPerHour: 0.008,
    providerRef: {},
    lastHeartbeatAt: new Date().toISOString(),
    activeCount: 1,
    createdAt: '2026-07-01T00:00:00Z',
    updatedAt: '2026-07-16T00:00:00Z',
  },
  {
    serverId: 'srv_oracle_1',
    name: 'oracle-fra-1',
    provider: 'oracle',
    serviceType: 'vm',
    region: 'eu-frankfurt-1',
    size: 'VM.Standard.A1.Flex',
    arch: 'arm64',
    status: 'ERROR',
    statusMessage: 'Provider API timeout',
    enabled: true,
    maxConcurrent: 2,
    costPerHour: 0,
    providerRef: {},
    activeCount: 0,
    createdAt: '2026-07-01T00:00:00Z',
    updatedAt: '2026-07-16T00:00:00Z',
  },
];

const FAKE_PROVIDERS = [
  {
    provider: 'hetzner',
    label: 'Hetzner Cloud',
    summary: 'Cheap EU ARM/x86 VMs.',
    creatable: true,
    requiresCredentials: true,
    credentialFields: [{ name: 'token', label: 'API token', kind: 'password' }],
    serviceTypes: [{ type: 'vm', label: 'Virtual machine', available: true }],
    regionSource: 'server',
    regions: [{ value: 'fsn1', label: 'Falkenstein, DE (fsn1)' }],
    sizes: [
      {
        value: 'cax11',
        label: 'CAX11 — Ampere ARM',
        arch: 'arm64',
        vcpu: 2,
        memGB: 4,
        costPerHour: 0.006,
      },
    ],
    defaultMaxConcurrent: 2,
    configured: true,
    placement: null,
  },
  {
    provider: 'aws',
    label: 'Amazon Web Services',
    summary: 'The existing EC2 daemon box.',
    creatable: false,
    unavailableNote: 'EC2 instances are declared as IaC in sst.config.ts, not provisioned here.',
    requiresCredentials: false,
    credentialFields: [],
    serviceTypes: [{ type: 'vm', label: 'Virtual machine', available: false }],
    regionSource: 'none',
    regions: [],
    sizes: [],
    defaultMaxConcurrent: 2,
    configured: true,
    placement: null,
  },
];

const FAKE_POLICY = {
  mode: 'priority',
  priorityOrder: ['srv_hetzner_1', 'srv_oracle_1'],
  weights: { srv_hetzner_1: 50, srv_oracle_1: 50 },
  updatedAt: '2026-07-16T00:00:00Z',
};

async function seedAuth(page: Page) {
  // use-auth.ts hydrates the auth store from localStorage (see
  // free-agent-widget.smoke.spec.ts) — seed both localStorage and
  // sessionStorage so AuthGuard resolves isAuthenticated=true synchronously.
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
      localStorage.setItem('futurator_tokens', JSON.stringify(tokens));
      localStorage.setItem('futurator_user', JSON.stringify(user));
      sessionStorage.setItem('futurator_tokens', JSON.stringify(tokens));
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
    // AppShell's header (AgentSpendPill / AgentPauseToggle) mounts on every
    // authed page — mock these so they don't crash on an unmatched shape.
    if (path.endsWith('/api/admin/spend')) {
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          date: '2026-07-16',
          totalCostUsd: 0,
          totalWalltimeSec: 0,
          rowCount: 0,
        }),
      });
    }
    if (path.endsWith('/api/admin/flags')) {
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ flags: [] }),
      });
    }
    if (path.endsWith('/api/servers/providers')) {
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ providers: FAKE_PROVIDERS }),
      });
    }
    if (path.endsWith('/api/servers/policy')) {
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ policy: FAKE_POLICY }),
      });
    }
    if (path.endsWith('/api/servers/assignments')) {
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify([]),
      });
    }
    if (path.endsWith('/api/servers')) {
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ servers: FAKE_SERVERS }),
      });
    }
    // Generic catch-all — empty success so unrelated panels don't crash.
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

test('Servers page renders the fleet and the Dispatch Policy mode selector', async ({
  authedPage,
}) => {
  const consoleErrors: string[] = [];
  authedPage.on('console', (msg) => {
    if (msg.type() === 'error') consoleErrors.push(msg.text());
  });
  authedPage.on('pageerror', (err) => consoleErrors.push(err.message));

  await authedPage.goto('/development/servers/');

  // 1. Both seeded server cards render with their status badges.
  await expect(authedPage.getByText('hetzner-fsn-1')).toBeVisible();
  await expect(authedPage.getByText('oracle-fra-1')).toBeVisible();
  await expect(authedPage.getByText('ACTIVE', { exact: true })).toBeVisible();
  await expect(authedPage.getByText('ERROR', { exact: true })).toBeVisible();

  // 2. Switch to the Dispatch Policy tab — the mode selector (real component,
  // not a placeholder) renders with all three modes.
  await authedPage.getByRole('tab', { name: 'Dispatch Policy' }).click();
  await expect(authedPage.getByRole('radiogroup', { name: 'Dispatch mode' })).toBeVisible();
  await expect(authedPage.getByText('Priority')).toBeVisible();
  await expect(authedPage.getByText('Weighted split')).toBeVisible();
  await expect(authedPage.getByText('Cheapest-first')).toBeVisible();

  // 3. No orphaned-component console errors.
  expect(consoleErrors).toEqual([]);
});

test('Add Server opens the wizard: creatable providers clickable, AWS disabled with a reason', async ({
  authedPage,
}) => {
  await authedPage.goto('/development/servers/');

  // The wizard is an action on the fleet, reachable by button — not a tab.
  await expect(authedPage.getByRole('tab', { name: 'Add Service' })).toHaveCount(0);
  await authedPage.getByRole('button', { name: '+ Add Server' }).first().click();

  const dialog = authedPage.getByRole('dialog');
  await expect(dialog.getByText('Add server')).toBeVisible();

  // Hetzner is creatable and already configured; its summary sells the choice.
  await expect(dialog.getByText('Hetzner Cloud')).toBeVisible();
  await expect(dialog.getByText('Configured ✓')).toBeVisible();

  // AWS has no adapter — it must render disabled WITH the reason, never lead
  // into a flow that fails after minting an IAM user.
  const awsCard = dialog.getByRole('button', { name: /Amazon Web Services/ });
  await expect(awsCard).toBeDisabled();
  await expect(dialog.getByText(/declared as IaC/)).toBeVisible();

  // Single-service-type providers skip the pointless "Virtual machine" step and
  // land straight on the shape form (Hetzner is pre-configured).
  await dialog.getByRole('button', { name: /Hetzner Cloud/ }).click();
  await expect(dialog.getByLabel('Server name')).toBeVisible();
  await expect(dialog.getByText('CAX11 — Ampere ARM')).toBeVisible();
  // Cost is seeded from the catalog, not left at a lying 0.
  await expect(dialog.getByLabel('Cost / hr (USD)')).toHaveValue('0.006');
});
