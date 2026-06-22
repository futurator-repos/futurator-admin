/**
 * party-assess-route.test.ts — Refactoring Assessment Module (Epic B1).
 *
 * Hermetic coverage of `POST /api/party/projects/:id/assess`:
 *   1. invalid projectId                  → 400 ValidationError (no DDB touched)
 *   2. missing project                    → 404 NotFound
 *   3. greenfield project                 → 400 INVALID_FOR_GREENFIELD
 *   4. brownfield row with no clone path  → 409 INVALID_STATE
 *   5. session PROCESSING for project     → 409 PROJECT_BUSY
 *   6. happy path (bare body)             → 202 { jobId, projectId } + refactor-audit job
 *   7. happy path (body opts)             → payload carries src/runL3/topN
 *
 * No real network calls. The DynamoDB doc client is fully mocked; auth
 * middleware is mocked to passthrough a fake user. Mirrors
 * party-refresh-route.test.ts.
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
  path?: string;
  kind?: 'greenfield' | 'brownfield';
  bmadStatus: 'MISSING' | 'INSTALLING' | 'HEALTHY' | 'DRIFTED' | 'CORRUPTED' | 'FAILED';
  gitRepoUrl?: string;
  gitBranch?: string;
  createdAt?: string;
  updatedAt?: string;
}

function brownfieldRow(overrides: Partial<ProjectRow> = {}): ProjectRow {
  return {
    projectId: 'applicator',
    path: '/home/ubuntu/projects/applicator',
    kind: 'brownfield',
    bmadStatus: 'HEALTHY',
    gitRepoUrl: 'https://github.com/foo/applicator.git',
    gitBranch: 'main',
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
    createdAt: '2026-04-17T00:00:00.000Z',
    updatedAt: '2026-04-17T00:00:00.000Z',
    ...overrides,
  };
}

async function postAssess(projectId: string, body: Record<string, unknown> = {}) {
  return app.request(`/api/party/projects/${encodeURIComponent(projectId)}/assess`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
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

describe('POST /api/party/projects/:id/assess — validation', () => {
  it('rejects an invalid projectId with 400 (Zod), touching no DDB', async () => {
    const res = await postAssess('UpperCaseInvalid');
    expect(res.status).toBe(400);
    expect(sendMock).not.toHaveBeenCalled();
  });
});

describe('POST /api/party/projects/:id/assess — not-found path', () => {
  it('returns 404 when the project row is missing', async () => {
    sendMock.mockResolvedValueOnce({}); // getProject → no Item
    const res = await postAssess('ghost-project');
    expect(res.status).toBe(404);
  });
});

describe('POST /api/party/projects/:id/assess — brownfield gate', () => {
  it('returns 400 INVALID_FOR_GREENFIELD when the project is greenfield', async () => {
    sendMock.mockResolvedValueOnce({ Item: greenfieldRow() });
    const res = await postAssess('bmad-canon');
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe('INVALID_FOR_GREENFIELD');
    // No session-busy query, no job created.
    expect(sendMock).toHaveBeenCalledTimes(1);
  });

  it('treats legacy rows missing kind as greenfield', async () => {
    const legacy = { ...greenfieldRow() } as Record<string, unknown>;
    delete legacy.kind;
    sendMock.mockResolvedValueOnce({ Item: legacy });
    const res = await postAssess('bmad-canon');
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe('INVALID_FOR_GREENFIELD');
  });

  it('returns 409 INVALID_STATE when a brownfield row has no clone path', async () => {
    sendMock.mockResolvedValueOnce({ Item: brownfieldRow({ path: undefined }) });
    const res = await postAssess('applicator');
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error.code).toBe('INVALID_STATE');
    // path guard fires before the session query.
    expect(sendMock).toHaveBeenCalledTimes(1);
  });
});

describe('POST /api/party/projects/:id/assess — concurrency gate', () => {
  it('returns 409 PROJECT_BUSY when a session for this project is PROCESSING', async () => {
    sendMock
      .mockResolvedValueOnce({ Item: brownfieldRow() }) // getProject
      .mockResolvedValueOnce({ Items: [{ sessionId: 'sess-1', status: 'PROCESSING' }] }); // hasProcessingSession
    const res = await postAssess('applicator');
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error.code).toBe('PROJECT_BUSY');
    // createJob must NOT have been called.
    expect(sendMock).toHaveBeenCalledTimes(2);
  });
});

describe('POST /api/party/projects/:id/assess — happy path', () => {
  it('returns 202 with { jobId, projectId } and enqueues a refactor-audit job', async () => {
    sendMock
      .mockResolvedValueOnce({ Item: brownfieldRow() }) // getProject
      .mockResolvedValueOnce({ Items: [] }) // hasProcessingSession → idle
      .mockResolvedValueOnce({}); // createJob PutCommand

    const res = await postAssess('applicator');
    expect(res.status).toBe(202);
    const body = await res.json();
    expect(body).toMatchObject({ projectId: 'applicator' });
    expect(body.jobId).toMatch(/^[0-9a-f-]{36}$/i);

    // Inspect the createJob PutCommand: refactor-audit jobType + payload.
    const createJobCall = sendMock.mock.calls[2][0];
    const input = (createJobCall as { input: Record<string, unknown> }).input;
    const item = input.Item as Record<string, unknown>;
    expect(item.jobType).toBe('refactor-audit');
    expect(item.status).toBe('PENDING');
    expect(item.workingDir).toBe('/home/ubuntu/projects/applicator');
    expect(item.projectId).toBe('applicator');
    const payload = item.refactorAuditPayload as Record<string, unknown>;
    expect(payload).toEqual({
      projectId: 'applicator',
      projectPath: '/home/ubuntu/projects/applicator',
    });
  });

  it('threads optional body opts (src/skipGraphify/runL3/topN) into the payload', async () => {
    sendMock
      .mockResolvedValueOnce({ Item: brownfieldRow() })
      .mockResolvedValueOnce({ Items: [] })
      .mockResolvedValueOnce({});

    const res = await postAssess('applicator', {
      src: 'app',
      skipGraphify: true,
      runL3: true,
      topN: 10,
    });
    expect(res.status).toBe(202);

    const createJobCall = sendMock.mock.calls[2][0];
    const input = (createJobCall as { input: Record<string, unknown> }).input;
    const item = input.Item as Record<string, unknown>;
    const payload = item.refactorAuditPayload as Record<string, unknown>;
    expect(payload).toEqual({
      projectId: 'applicator',
      projectPath: '/home/ubuntu/projects/applicator',
      src: 'app',
      skipGraphify: true,
      runL3: true,
      topN: 10,
    });
  });

  it('rejects a malformed body (topN out of range) with 400 before any DDB call', async () => {
    const res = await postAssess('applicator', { topN: 9999 });
    expect(res.status).toBe(400);
    expect(sendMock).not.toHaveBeenCalled();
  });
});
