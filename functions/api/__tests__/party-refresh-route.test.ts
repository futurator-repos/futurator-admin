/**
 * party-refresh-route.test.ts — Story 15.4 AC #12 (API-layer test gap).
 *
 * Hermetic coverage of `POST /api/party/projects/:id/refresh`:
 *   1. invalid projectId                       → 400 ValidationError
 *   2. missing project                         → 404 NotFound
 *   3. greenfield project                      → 400 INVALID_FOR_GREENFIELD
 *   4. brownfield without gitBranch (broken row) → 400 INVALID_FOR_GREENFIELD
 *   5. session PROCESSING for project          → 409 PROJECT_BUSY
 *   6. refresh lock already held               → 409 REFRESH_IN_PROGRESS
 *   7. happy path                              → 202 with { jobId, projectId }
 *
 * No real network calls. The DynamoDB doc client is fully mocked so the
 * route can be driven by setting mock return values in a deterministic
 * order. Auth middleware is mocked to passthrough a fake user.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── 1. Mock auth-middleware ─────────────────────────────────────────────────
vi.mock('../../shared/auth-middleware', () => ({
  authMiddleware: vi.fn(
    async (c: { set: (k: string, v: unknown) => void }, next: () => Promise<void>) => {
      c.set('user', { userId: 'u1', email: 'u@example.com', name: 'U' });
      await next();
    },
  ),
}));

// ── 2. Mock dynamo-client ───────────────────────────────────────────────────
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

// ── 3. Import the app after mocks are registered ────────────────────────────
import { app } from '../index';

// ── Helpers ─────────────────────────────────────────────────────────────────

interface ProjectRow {
  projectId: string;
  path: string;
  kind?: 'greenfield' | 'brownfield';
  bmadStatus:
    | 'MISSING'
    | 'INSTALLING'
    | 'HEALTHY'
    | 'DRIFTED'
    | 'CORRUPTED'
    | 'FAILED'
    | 'REFRESHING';
  gitRepoUrl?: string;
  gitBranch?: string;
  expectedAgentCount?: number;
  createdAt?: string;
  updatedAt?: string;
}

function brownfieldRow(overrides: Partial<ProjectRow> = {}): ProjectRow {
  return {
    projectId: 'songster',
    path: '/home/ubuntu/projects/songster',
    kind: 'brownfield',
    bmadStatus: 'HEALTHY',
    gitRepoUrl: 'https://github.com/foo/songster.git',
    gitBranch: 'main',
    expectedAgentCount: 6,
    createdAt: '2026-05-17T00:00:00.000Z',
    updatedAt: '2026-05-17T00:00:00.000Z',
    ...overrides,
  };
}

function greenfieldRow(overrides: Partial<ProjectRow> = {}): ProjectRow {
  return {
    projectId: 'bmad-canon',
    path: '/home/ubuntu/projects/bmad-canon',
    kind: 'greenfield',
    bmadStatus: 'HEALTHY',
    expectedAgentCount: 6,
    createdAt: '2026-04-17T00:00:00.000Z',
    updatedAt: '2026-04-17T00:00:00.000Z',
    ...overrides,
  };
}

async function postRefresh(projectId: string) {
  return app.request(`/api/party/projects/${encodeURIComponent(projectId)}/refresh`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({}),
  });
}

beforeEach(async () => {
  vi.resetAllMocks();
  sendMock.mockReset();
  const { authMiddleware } = await import('../../shared/auth-middleware');
  vi.mocked(authMiddleware).mockImplementation(
    async (c: { set: (k: string, v: unknown) => void }, next: () => Promise<void>) => {
      c.set('user', { userId: 'u1', email: 'u@example.com', name: 'U' });
      await next();
    },
  );
});

// ────────────────────────────────────────────────────────────────────────────

describe('POST /api/party/projects/:id/refresh — validation', () => {
  it('rejects an invalid projectId with 400 (Zod)', async () => {
    const res = await postRefresh('UpperCaseInvalid');
    expect(res.status).toBe(400);
    // DDB should NOT have been touched on a validation failure.
    expect(sendMock).not.toHaveBeenCalled();
  });
});

describe('POST /api/party/projects/:id/refresh — not-found path', () => {
  it('returns 404 when the project row is missing', async () => {
    // getProject → no Item
    sendMock.mockResolvedValueOnce({});
    const res = await postRefresh('ghost-project');
    expect(res.status).toBe(404);
  });
});

describe('POST /api/party/projects/:id/refresh — greenfield gate (AC #6)', () => {
  it('returns 400 INVALID_FOR_GREENFIELD when the project is greenfield', async () => {
    sendMock.mockResolvedValueOnce({ Item: greenfieldRow() });
    const res = await postRefresh('bmad-canon');
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe('INVALID_FOR_GREENFIELD');
    // No session-busy query, no lock acquisition, no job created.
    expect(sendMock).toHaveBeenCalledTimes(1);
  });

  it('returns 400 INVALID_FOR_GREENFIELD when a row has kind=brownfield but no gitBranch', async () => {
    // Defensive — if a brownfield row somehow lost its gitBranch, the
    // endpoint refuses to refresh rather than passing undefined to the daemon.
    sendMock.mockResolvedValueOnce({
      Item: brownfieldRow({ gitBranch: undefined }),
    });
    const res = await postRefresh('songster');
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe('INVALID_FOR_GREENFIELD');
  });

  it('treats legacy rows missing kind as greenfield via lazy migration', async () => {
    // No `kind` field on the row — lazy migration assigns 'greenfield'.
    const legacy = { ...greenfieldRow() } as Record<string, unknown>;
    delete legacy.kind;
    sendMock.mockResolvedValueOnce({ Item: legacy });
    const res = await postRefresh('bmad-canon');
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe('INVALID_FOR_GREENFIELD');
  });
});

describe('POST /api/party/projects/:id/refresh — concurrency gates (AC #7)', () => {
  it('returns 409 PROJECT_BUSY when a session for this project is PROCESSING', async () => {
    // 1: getProject → brownfield, 2: hasProcessingSession → 1 hit
    sendMock
      .mockResolvedValueOnce({ Item: brownfieldRow() })
      .mockResolvedValueOnce({ Items: [{ sessionId: 'sess-1', status: 'PROCESSING' }] });

    const res = await postRefresh('songster');
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error.code).toBe('PROJECT_BUSY');
    // tryAcquireRefreshLock and createJob must NOT have been called.
    expect(sendMock).toHaveBeenCalledTimes(2);
  });

  it('returns 409 REFRESH_IN_PROGRESS when the refresh lock is already held', async () => {
    // 1: getProject → brownfield (HEALTHY)
    // 2: hasProcessingSession → no hits
    // 3: tryAcquireRefreshLock UpdateCommand → ConditionalCheckFailedException
    // 4: re-fetch row inside tryAcquireRefreshLock → returns REFRESHING row
    const conditionalFailure = Object.assign(new Error('conditional failed'), {
      name: 'ConditionalCheckFailedException',
    });
    sendMock
      .mockResolvedValueOnce({ Item: brownfieldRow() })
      .mockResolvedValueOnce({ Items: [] })
      .mockRejectedValueOnce(conditionalFailure)
      .mockResolvedValueOnce({ Item: brownfieldRow({ bmadStatus: 'REFRESHING' }) });

    const res = await postRefresh('songster');
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error.code).toBe('REFRESH_IN_PROGRESS');
    // createJob must NOT have been called.
    expect(sendMock).toHaveBeenCalledTimes(4);
  });
});

describe('POST /api/party/projects/:id/refresh — happy path (AC #6)', () => {
  it('returns 202 with { jobId, projectId } and enqueues a party-refresh job', async () => {
    // 1: getProject → brownfield HEALTHY
    // 2: hasProcessingSession → no hits
    // 3: tryAcquireRefreshLock UpdateCommand → success
    // 4: agentJobsRepo.createJob PutCommand → success
    sendMock
      .mockResolvedValueOnce({ Item: brownfieldRow() })
      .mockResolvedValueOnce({ Items: [] })
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({});

    const res = await postRefresh('songster');
    expect(res.status).toBe(202);
    const body = await res.json();
    expect(body).toMatchObject({ projectId: 'songster' });
    expect(body.jobId).toMatch(/^[0-9a-f-]{36}$/i);

    // Inspect the createJob PutCommand: party-refresh jobType + payload.
    const createJobCall = sendMock.mock.calls[3][0];
    const input = (createJobCall as { input: Record<string, unknown> }).input;
    const item = input.Item as Record<string, unknown>;
    expect(item.jobType).toBe('party-refresh');
    expect(item.status).toBe('PENDING');
    const payload = item.partyRefreshPayload as Record<string, unknown>;
    expect(payload).toEqual({
      projectId: 'songster',
      projectPath: '/home/ubuntu/projects/songster',
      gitBranch: 'main',
    });
  });
});
