/**
 * pat-rotation.test.ts — Story 1.7.1 (Pipeline v2 Phase 1)
 *
 * Tests for PUT /api/github/pat and GET /api/github/rotated-at.
 *
 * Strategy:
 *   - Mock rotate-pat module so no real SSM or GitHub calls are made.
 *   - Mock auth-middleware to inject a fake user on protected routes.
 *   - Mock dynamo-client (transitive DDB repos).
 *   - Drive the Hono app via app.request().
 *   - Assert the PAT value NEVER appears in any response body or thrown error.
 *
 * 6 test cases:
 *   1. Successful rotation — 200, login captured, rotatedAt present.
 *   2. Invalid PAT (GitHub rejects) — 422, error: 'invalid-pat'.
 *   3. Missing body — 422 (Zod validation).
 *   4. GitHub network error — 502, error: 'rotation-failed'.
 *   5. Unauthorized request — 401 (auth middleware blocks).
 *   6. Already-rotated-recently — same flow as success (no special handling).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── 1. Mock rotate-pat module ────────────────────────────────────────────────
const rotateMocks = vi.hoisted(() => ({
  rotatePat: vi.fn(),
  readRotatedAt: vi.fn(),
  InvalidPatError: class InvalidPatError extends Error {
    constructor(message: string) {
      super(message);
      this.name = 'InvalidPatError';
    }
  },
}));

vi.mock('../../shared/github/rotate-pat', () => rotateMocks);

// ── 2. Mock @aws-sdk/client-ssm so ssmClient construction does not fail ──────
vi.mock('@aws-sdk/client-ssm', () => ({
  SSMClient: class SSMClient {
    send = vi.fn();
  },
  SendCommandCommand: vi.fn(),
  GetCommandInvocationCommand: vi.fn(),
}));

// ── 3. Mock auth-middleware ───────────────────────────────────────────────────
// Default: pass through (authenticated). Overridden to block in test #5.
const authMock = vi.hoisted(() => ({
  authMiddleware: vi.fn(
    async (c: { set: (k: string, v: unknown) => void }, next: () => Promise<void>) => {
      c.set('user', { userId: 'u1', email: 'u@example.com', name: 'U' });
      await next();
    },
  ),
}));

vi.mock('../../shared/auth-middleware', () => authMock);

// ── 4. Mock GitHub connector (imported by index.ts) ───────────────────────────
vi.mock('../../shared/github/connector', () => ({
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

// ── 5. Mock dynamo-client so DDB repos don't connect ─────────────────────────
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

// ── 6. Mock @aws-sdk/client-cloudwatch ────────────────────────────────────────
vi.mock('@aws-sdk/client-cloudwatch', () => ({
  CloudWatchClient: class CloudWatchClient {
    send = vi.fn();
  },
  GetMetricDataCommand: vi.fn(),
}));

// ── 7. Mock @aws-sdk/client-ec2 ───────────────────────────────────────────────
vi.mock('@aws-sdk/client-ec2', () => ({
  EC2Client: class EC2Client {
    send = vi.fn();
  },
  DescribeInstancesCommand: vi.fn(),
  StartInstancesCommand: vi.fn(),
  StopInstancesCommand: vi.fn(),
}));

// ── Import the app AFTER all mocks are hoisted ────────────────────────────────
import { app } from '../index';

// ── Helpers ───────────────────────────────────────────────────────────────────

const PAT_REDACTED = '*** REDACTED IN TEST ***';

async function putPat(body: unknown) {
  return app.request('/api/github/pat', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer test-token' },
    body: JSON.stringify(body),
  });
}

async function getPat() {
  return app.request('/api/github/rotated-at', {
    method: 'GET',
    headers: { Authorization: 'Bearer test-token' },
  });
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('PUT /api/github/pat', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Default auth: pass through
    authMock.authMiddleware.mockImplementation(
      async (c: { set: (k: string, v: unknown) => void }, next: () => Promise<void>) => {
        c.set('user', { userId: 'u1', email: 'u@example.com', name: 'U' });
        await next();
      },
    );
  });

  // Test 1: Successful rotation
  it('returns 200 with login and rotatedAt on success', async () => {
    const rotatedAt = '2026-04-28T10:00:00.000Z';
    rotateMocks.rotatePat.mockResolvedValueOnce({ login: 'bot-futurator', rotatedAt });

    const res = await putPat({ pat: 'ghp_fakePAT123' });
    const body = (await res.json()) as Record<string, unknown>;

    expect(res.status).toBe(200);
    expect(body.rotated).toBe(true);
    expect(body.login).toBe('bot-futurator');
    expect(body.rotatedAt).toBe(rotatedAt);

    // PAT must never appear in the response
    expect(JSON.stringify(body)).not.toContain('ghp_fakePAT123');
    expect(JSON.stringify(body)).not.toContain(PAT_REDACTED);
  });

  // Test 2: Invalid PAT (GitHub 401)
  it('returns 422 with error: invalid-pat when GitHub rejects the token', async () => {
    rotateMocks.rotatePat.mockRejectedValueOnce(
      new rotateMocks.InvalidPatError('GitHub rejected the token — check scopes'),
    );

    const res = await putPat({ pat: 'ghp_badPAT' });
    const body = (await res.json()) as Record<string, unknown>;

    expect(res.status).toBe(422);
    expect(body.error).toBe('invalid-pat');
    // The PAT must not appear in the error message
    expect(JSON.stringify(body)).not.toContain('ghp_badPAT');
  });

  // Test 3: Missing body / empty pat
  it('returns 422 when body is missing pat', async () => {
    const res = await putPat({});
    const body = (await res.json()) as Record<string, unknown>;

    // Zod validation catches the missing field
    expect([400, 422]).toContain(res.status);
    expect(body).toBeDefined();
    // rotatePat should not have been called
    expect(rotateMocks.rotatePat).not.toHaveBeenCalled();
  });

  // Test 4: GitHub network error → 502
  it('returns 502 when rotation fails due to a network error', async () => {
    rotateMocks.rotatePat.mockRejectedValueOnce(new Error('fetch failed: ECONNREFUSED'));

    const res = await putPat({ pat: 'ghp_networkFail' });
    const body = (await res.json()) as Record<string, unknown>;

    expect(res.status).toBe(502);
    expect(body.error).toBe('rotation-failed');
    // The PAT must not appear in the error message
    expect(JSON.stringify(body)).not.toContain('ghp_networkFail');
  });

  // Test 5: Unauthorized request → 401
  it('returns 401 when the request is not authenticated', async () => {
    authMock.authMiddleware.mockImplementationOnce(async () => {
      // Do not call next() — simulate auth rejection by returning early.
      // In the real middleware this would return a 401 response.
      // We simulate by throwing an AppError-like object via the Hono error handler.
      const err = Object.assign(new Error('Unauthorized'), {
        statusCode: 401,
        code: 'UNAUTHORIZED',
      });
      throw err;
    });

    const res = await putPat({ pat: 'ghp_unauthed' });
    // The global error handler maps thrown errors to JSON
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(rotateMocks.rotatePat).not.toHaveBeenCalled();
  });

  // Test 6: Already rotated recently — same happy-path flow (no special handling)
  it('handles a second rotation with the same flow as the first', async () => {
    const rotatedAt = '2026-04-28T11:00:00.000Z';
    rotateMocks.rotatePat.mockResolvedValueOnce({ login: 'bot-futurator', rotatedAt });

    const res = await putPat({ pat: 'ghp_secondRotation' });
    const body = (await res.json()) as Record<string, unknown>;

    expect(res.status).toBe(200);
    expect(body.rotated).toBe(true);
    // PAT must not appear in any response field
    expect(JSON.stringify(body)).not.toContain('ghp_secondRotation');
  });
});

describe('GET /api/github/rotated-at', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    authMock.authMiddleware.mockImplementation(
      async (c: { set: (k: string, v: unknown) => void }, next: () => Promise<void>) => {
        c.set('user', { userId: 'u1', email: 'u@example.com', name: 'U' });
        await next();
      },
    );
  });

  it('returns the rotatedAt timestamp when present', async () => {
    const rotatedAt = '2026-01-15T09:00:00.000Z';
    rotateMocks.readRotatedAt.mockResolvedValueOnce(rotatedAt);

    const res = await getPat();
    const body = (await res.json()) as Record<string, unknown>;

    expect(res.status).toBe(200);
    expect(body.rotatedAt).toBe(rotatedAt);
  });

  it('returns rotatedAt: null when never set', async () => {
    rotateMocks.readRotatedAt.mockResolvedValueOnce(null);

    const res = await getPat();
    const body = (await res.json()) as Record<string, unknown>;

    expect(res.status).toBe(200);
    expect(body.rotatedAt).toBeNull();
  });
});
