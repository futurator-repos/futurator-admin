/**
 * servers-routes.test.ts — Servers module (Task 7) API wiring.
 *
 * Hermetic coverage of the three operator routes added to the Hono app:
 *   GET  /api/servers/policy       → { policy }
 *   PUT  /api/servers/policy       → validates body, saves, runs a sweep → { policy, sweep }
 *   GET  /api/servers/assignments  → last N agent-jobs carrying assignedServerId
 *
 * `dispatch-state`, `server-dispatcher`, `dynamo-client`, and `auth-middleware`
 * are all mocked; mirrors functions/api/__tests__/qa-review-p3-routes.test.ts.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../auth-middleware', () => ({
  authMiddleware: vi.fn(
    async (c: { set: (k: string, v: unknown) => void }, next: () => Promise<void>) => {
      c.set('user', { userId: 'u1', email: 'ric@example.com', name: 'Ric' });
      await next();
    },
  ),
}));

const { getPolicyMock, setPolicyMock, sweepMock, sendMock } = vi.hoisted(() => ({
  getPolicyMock: vi.fn(),
  setPolicyMock: vi.fn(),
  sweepMock: vi.fn(),
  sendMock: vi.fn(),
}));

vi.mock('../dispatch-state', () => ({
  getDispatchPolicy: getPolicyMock,
  setDispatchPolicy: setPolicyMock,
}));

vi.mock('../server-dispatcher', () => ({
  runDispatchSweep: sweepMock,
}));

vi.mock('../../dynamo-client', () => ({
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
    servers: 'test-servers',
  },
}));

import { app } from '../../../api/index';

const POLICY = { mode: 'priority', priorityOrder: ['srv_a'], weights: {}, updatedAt: 'now' };
const SWEEP = {
  skipped: false,
  assigned: 2,
  unassigned: 0,
  reassignedFromStale: 0,
  orphansReleased: 0,
};

beforeEach(() => {
  getPolicyMock.mockReset();
  setPolicyMock.mockReset();
  sweepMock.mockReset();
  sendMock.mockReset();
});

describe('GET /api/servers/policy', () => {
  it('returns the current dispatch policy', async () => {
    getPolicyMock.mockResolvedValue(POLICY);
    const res = await app.request('/api/servers/policy');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ policy: POLICY });
  });
});

describe('PUT /api/servers/policy', () => {
  it('rejects an invalid mode with 400', async () => {
    const res = await app.request('/api/servers/policy', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ mode: 'random', priorityOrder: [], weights: {} }),
    });
    expect(res.status).toBe(400);
    expect(setPolicyMock).not.toHaveBeenCalled();
    expect(sweepMock).not.toHaveBeenCalled();
  });

  it('saves the policy and runs a sweep on the happy path', async () => {
    setPolicyMock.mockResolvedValue(POLICY);
    sweepMock.mockResolvedValue(SWEEP);
    const res = await app.request('/api/servers/policy', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ mode: 'priority', priorityOrder: ['srv_a'], weights: {} }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ policy: POLICY, sweep: SWEEP });
    expect(setPolicyMock).toHaveBeenCalledWith(
      { mode: 'priority', priorityOrder: ['srv_a'], weights: {} },
      'u1',
    );
    expect(sweepMock).toHaveBeenCalledTimes(1);
  });
});

describe('GET /api/servers/assignments', () => {
  it('merges PENDING+RUNNING assigned jobs newest-first and maps fields', async () => {
    const pending = {
      jobId: 'j_pending',
      jobType: 'queue-request',
      status: 'PENDING',
      assignedServerId: 'srv_a',
      assignReason: 'priority: 1 of [srv_a]',
      assignedAt: '2026-07-16T00:00:02Z',
      createdAt: '2026-07-16T00:00:02Z',
    };
    const running = {
      jobId: 'j_running',
      jobType: 'queue-request',
      status: 'RUNNING',
      assignedServerId: 'srv_b',
      assignReason: 'pinned to srv_b',
      assignedAt: '2026-07-16T00:00:05Z',
      createdAt: '2026-07-16T00:00:05Z',
    };
    sendMock.mockImplementation((cmd: { input?: Record<string, unknown> }) => {
      const status = (cmd.input?.ExpressionAttributeValues as Record<string, string>)?.[':status'];
      if (status === 'PENDING') return Promise.resolve({ Items: [pending] });
      if (status === 'RUNNING') return Promise.resolve({ Items: [running] });
      return Promise.resolve({ Items: [] });
    });

    const res = await app.request('/api/servers/assignments');
    expect(res.status).toBe(200);
    const body = (await res.json()) as Array<Record<string, unknown>>;
    // newest-first: running (00:00:05) before pending (00:00:02)
    expect(body.map((r) => r.jobId)).toEqual(['j_running', 'j_pending']);
    expect(body[0]).toEqual({
      jobId: 'j_running',
      jobType: 'queue-request',
      status: 'RUNNING',
      assignedServerId: 'srv_b',
      assignReason: 'pinned to srv_b',
      assignedAt: '2026-07-16T00:00:05Z',
      createdAt: '2026-07-16T00:00:05Z',
    });
  });
});
