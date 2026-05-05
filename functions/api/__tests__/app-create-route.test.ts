/**
 * app-create-route.test.ts — Pipeline v2 / Stories 1.4.2 + 1.4.4.
 *
 * Hermetic coverage of `POST /api/apps` saga:
 *   1. invalid slug                    (Zod 400)
 *   2. slug taken in DDB              (409 APP_ID_TAKEN)
 *   3. slug taken on GitHub           (409 REPO_EXISTS via getRepo 200)
 *   4. invalid templateType           (Zod 400)
 *   5. createRepoFromTemplate `existing: true`  (409 REPO_EXISTS)
 *   6. happy path                     (201 with appId + jobId)
 *   7. transaction failure → rollback (Gate G-7) — `deleteRepo` called once,
 *                                                  500 returned, no orphan App
 *   8. transaction failure → rollback ALSO fails — attention item written
 *
 * No real network calls. The connector and DynamoDB client are mocked end-
 * to-end so the saga can be driven by setting mock return values.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── 1. Mock the GitHub connector ────────────────────────────────────────────
const connectorMocks = vi.hoisted(() => ({
  checkConnection: vi.fn(),
  listRepos: vi.fn(),
  getRepo: vi.fn(),
  getRepoTree: vi.fn(),
  getFileContent: vi.fn(),
  createRepoFromTemplate: vi.fn(),
  deleteRepo: vi.fn(),
  GitHubError: class GitHubError extends Error {
    status: number;
    rateLimit?: { limit: number; remaining: number; reset: number };
    constructor(
      message: string,
      status: number,
      rateLimit?: { limit: number; remaining: number; reset: number },
    ) {
      super(message);
      this.name = 'GitHubError';
      this.status = status;
      this.rateLimit = rateLimit;
    }
  },
}));
vi.mock('../../shared/github/connector', () => connectorMocks);

// ── 2. Mock auth-middleware ─────────────────────────────────────────────────
vi.mock('../../shared/auth-middleware', () => ({
  authMiddleware: vi.fn(
    async (c: { set: (k: string, v: unknown) => void }, next: () => Promise<void>) => {
      c.set('user', { userId: 'u1', email: 'u@example.com', name: 'U' });
      await next();
    },
  ),
}));

// ── 3. Mock dynamo-client ───────────────────────────────────────────────────
const { sendMock } = vi.hoisted(() => ({ sendMock: vi.fn() }));
vi.mock('../../shared/dynamo-client', () => ({
  docClient: { send: sendMock },
  TABLE_NAMES: {
    projects: 'test-projects',
    costs: 'test-costs',
    resources: 'test-resources',
    audits: 'test-audits',
    schedules: 'test-schedules',
    users: 'test-users',
    alerts: 'test-alerts',
    agentJobs: 'test-agent-jobs',
    agentEvents: 'test-agent-events',
    epicWorkflows: 'test-epic-workflows',
    projectRegistry: 'test-project-registry',
    partyProjects: 'test-party-projects',
    partySessions: 'test-party-sessions',
    plans: 'test-plans',
    apps: 'test-apps',
    attentionItems: 'test-attention-items',
    agentSessions: 'test-agent-sessions',
    agentConversations: 'test-agent-conversations',
  },
}));

// ── 4. Import the app after mocks are registered ────────────────────────────
import { app } from '../index';
import { GetCommand, TransactWriteCommand, PutCommand } from '@aws-sdk/lib-dynamodb';

// ── Helpers ─────────────────────────────────────────────────────────────────

const RATE = { limit: 5000, remaining: 4900, reset: 1700000000 };

function makeRepo(name: string) {
  return {
    id: 1,
    name,
    full_name: `futurator-repos/${name}`,
    owner: { login: 'futurator-repos', id: 42 },
    private: true,
    description: null,
    default_branch: 'main',
    clone_url: `https://github.com/futurator-repos/${name}.git`,
    html_url: `https://github.com/futurator-repos/${name}`,
    is_template: false,
    pushed_at: '2026-04-28T00:00:00Z',
    created_at: '2026-04-28T00:00:00Z',
    updated_at: '2026-04-28T00:00:00Z',
    topics: [],
  };
}

async function postCreateApp(body: unknown) {
  return app.request('/api/apps', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

beforeEach(async () => {
  vi.resetAllMocks();
  sendMock.mockReset();
  // Re-wire auth middleware passthrough
  const { authMiddleware } = await import('../../shared/auth-middleware');
  vi.mocked(authMiddleware).mockImplementation(
    async (c: { set: (k: string, v: unknown) => void }, next: () => Promise<void>) => {
      c.set('user', { userId: 'u1', email: 'u@example.com', name: 'U' });
      await next();
    },
  );
});

// ────────────────────────────────────────────────────────────────────────────

describe('POST /api/apps — Zod validation', () => {
  it('rejects an invalid slug with 400', async () => {
    const res = await postCreateApp({
      appId: 'BadSlug', // Uppercase + no kebab — fails the regex
      displayName: 'Bad',
      boilerplateType: 'nextjs',
    });
    expect(res.status).toBe(400);
  });

  it('rejects an invalid templateType with 400', async () => {
    const res = await postCreateApp({
      appId: 'good-slug',
      displayName: 'Good',
      boilerplateType: 'unknown-type',
    });
    expect(res.status).toBe(400);
  });
});

describe('POST /api/apps — slug-collision branches', () => {
  it('returns 409 APP_ID_TAKEN when slug is already in DDB', async () => {
    // Mock: appRepo.getApp returns an existing row → 409 before GitHub call.
    sendMock.mockImplementationOnce(async () => ({
      Item: { appId: 'taken-app', displayName: 'Existing' },
    }));

    const res = await postCreateApp({
      appId: 'taken-app',
      displayName: 'New',
      boilerplateType: 'nextjs',
    });
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error.code).toBe('APP_ID_TAKEN');
    // GitHub API should never have been called
    expect(connectorMocks.getRepo).not.toHaveBeenCalled();
  });

  it('returns 409 REPO_EXISTS when slug exists on GitHub already', async () => {
    // DDB pre-check: not found
    sendMock.mockImplementationOnce(async () => ({ Item: null }));
    // getRepo returns 200 → repo already exists
    connectorMocks.getRepo.mockResolvedValueOnce({
      data: makeRepo('orphan-slug'),
      rateLimit: RATE,
    });

    const res = await postCreateApp({
      appId: 'orphan-slug',
      displayName: 'Orphan',
      boilerplateType: 'nextjs',
    });
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error.code).toBe('REPO_EXISTS');
    expect(connectorMocks.createRepoFromTemplate).not.toHaveBeenCalled();
  });

  it('returns 409 REPO_EXISTS when createRepoFromTemplate reports existing', async () => {
    sendMock.mockImplementationOnce(async () => ({ Item: null })); // DDB clean
    connectorMocks.getRepo.mockRejectedValueOnce(
      new connectorMocks.GitHubError('Not Found', 404, RATE),
    );
    // create returns the idempotency envelope
    connectorMocks.createRepoFromTemplate.mockResolvedValueOnce({
      data: { existing: true, repo: makeRepo('race-slug') },
      rateLimit: RATE,
    });

    const res = await postCreateApp({
      appId: 'race-slug',
      displayName: 'Race',
      boilerplateType: 'nextjs',
    });
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error.code).toBe('REPO_EXISTS');
  });
});

describe('POST /api/apps — happy path', () => {
  it('returns 201 with appId + jobId on success', async () => {
    sendMock.mockImplementation(async (cmd: unknown) => {
      if (cmd instanceof GetCommand) return { Item: null };
      if (cmd instanceof TransactWriteCommand) return {};
      return {};
    });
    connectorMocks.getRepo.mockRejectedValueOnce(
      new connectorMocks.GitHubError('Not Found', 404, RATE),
    );
    connectorMocks.createRepoFromTemplate.mockResolvedValueOnce({
      data: makeRepo('happy-app'),
      rateLimit: RATE,
    });

    const res = await postCreateApp({
      appId: 'happy-app',
      displayName: 'Happy App',
      // PR-13 — accept legacy 'nextjs' input; saga normalizes to 'nextjs-base'.
      boilerplateType: 'nextjs',
      bmadEnabled: true,
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.app.appId).toBe('happy-app');
    expect(body.app.boilerplateType).toBe('nextjs-base');
    expect(body.app.bmadEnabled).toBe(true);
    expect(typeof body.jobId).toBe('string');
    expect(body.jobId.length).toBeGreaterThan(10);
    // No rollback on the happy path
    expect(connectorMocks.deleteRepo).not.toHaveBeenCalled();
  });

  it('applies legacy back-compat defaults when boilerplateType is omitted', async () => {
    sendMock.mockImplementation(async (cmd: unknown) => {
      if (cmd instanceof GetCommand) return { Item: null };
      if (cmd instanceof TransactWriteCommand) return {};
      return {};
    });
    connectorMocks.getRepo.mockRejectedValueOnce(
      new connectorMocks.GitHubError('Not Found', 404, RATE),
    );
    connectorMocks.createRepoFromTemplate.mockResolvedValueOnce({
      data: makeRepo('legacy-app'),
      rateLimit: RATE,
    });

    const res = await postCreateApp({
      appId: 'legacy-app',
      displayName: 'Legacy',
      // no boilerplateType, no bmadEnabled
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    // PR-13 — default normalized to 'nextjs-base' (legacy 'nextjs' alias maps here).
    expect(body.app.boilerplateType).toBe('nextjs-base');
    expect(body.app.bmadEnabled).toBe(true);
  });
});

describe('POST /api/apps — saga rollback (Gate G-7)', () => {
  it('rolls back the GitHub repo when the DDB transaction fails', async () => {
    sendMock.mockImplementation(async (cmd: unknown) => {
      if (cmd instanceof GetCommand) return { Item: null }; // DDB clean
      if (cmd instanceof TransactWriteCommand) {
        const err = new Error('TransactionCanceled');
        err.name = 'TransactionCanceledException';
        throw err;
      }
      return {};
    });
    connectorMocks.getRepo.mockRejectedValueOnce(
      new connectorMocks.GitHubError('Not Found', 404, RATE),
    );
    connectorMocks.createRepoFromTemplate.mockResolvedValueOnce({
      data: makeRepo('rollback-slug'),
      rateLimit: RATE,
    });
    connectorMocks.deleteRepo.mockResolvedValueOnce({
      data: { deleted: true },
      rateLimit: RATE,
    });

    const res = await postCreateApp({
      appId: 'rollback-slug',
      displayName: 'Rollback',
      boilerplateType: 'nextjs',
    });
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error.code).toBe('APP_CREATE_FAILED');
    // Rollback must have fired exactly once with the right slug
    expect(connectorMocks.deleteRepo).toHaveBeenCalledTimes(1);
    expect(connectorMocks.deleteRepo).toHaveBeenCalledWith('futurator-repos', 'rollback-slug');

    // No PutCommand was issued for this app row outside the failed
    // transaction (the transaction is the only writer of the App row).
    const putCalls = sendMock.mock.calls.filter((c: unknown[]) => c[0] instanceof PutCommand);
    // The only PutCommand that may have fired is the orphan attention item;
    // since the rollback succeeded, there should be NO attention writes.
    expect(putCalls).toHaveLength(0);
  });

  it('writes a rollback-orphan attention item when deleteRepo also fails', async () => {
    sendMock.mockImplementation(async (cmd: unknown) => {
      if (cmd instanceof GetCommand) return { Item: null };
      if (cmd instanceof TransactWriteCommand) {
        const err = new Error('TransactionCanceled');
        err.name = 'TransactionCanceledException';
        throw err;
      }
      if (cmd instanceof PutCommand) return {}; // attention-item put OK
      return {};
    });
    connectorMocks.getRepo.mockRejectedValueOnce(
      new connectorMocks.GitHubError('Not Found', 404, RATE),
    );
    connectorMocks.createRepoFromTemplate.mockResolvedValueOnce({
      data: makeRepo('orphan-rollback'),
      rateLimit: RATE,
    });
    connectorMocks.deleteRepo.mockRejectedValueOnce(
      new connectorMocks.GitHubError('Server error', 500, RATE),
    );

    const res = await postCreateApp({
      appId: 'orphan-rollback',
      displayName: 'Orphan',
      boilerplateType: 'nextjs',
    });
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error.code).toBe('APP_CREATE_FAILED');
    // Original 500 is NOT swallowed by the rollback failure — body message
    // must hint at the orphan.
    expect(body.error.message).toMatch(/orphan/i);

    // Exactly one attention-item PutCommand was issued, against the
    // attentionItems table, with the orphan category.
    const attentionPuts = sendMock.mock.calls
      .map((c: unknown[]) => c[0])
      .filter(
        (cmd: unknown): cmd is PutCommand =>
          cmd instanceof PutCommand &&
          (cmd as PutCommand).input?.TableName === 'test-attention-items',
      );
    expect(attentionPuts).toHaveLength(1);
    const item = attentionPuts[0].input?.Item as { category?: string; planId?: string } | undefined;
    expect(item?.category).toBe('pv2-app-bootstrap-rollback-orphan');
    expect(item?.planId).toBe('app:orphan-rollback');
  });
});
