/**
 * apply-concept-plan-route.test.ts — Concept v2 integration.
 *
 * Hermetic coverage of `POST /api/plans/:id/apply-concept-plan`:
 *   1. happy path — COMPLETED concept-route job → conceptPlan persisted (200)
 *   2. parse failure — invalid CONCEPT_PLAN_JSON → 400 PARSE_FAILED
 *   3. job not COMPLETED → 400 ValidationError
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../shared/auth-middleware', () => ({
  authMiddleware: vi.fn(
    async (c: { set: (k: string, v: unknown) => void }, next: () => Promise<void>) => {
      c.set('user', { userId: 'u1', email: 'u@example.com', name: 'U' });
      await next();
    },
  ),
}));

const { sendMock } = vi.hoisted(() => ({ sendMock: vi.fn() }));
vi.mock('../../shared/dynamo-client', () => ({
  docClient: { send: sendMock },
  TABLE_NAMES: {
    plans: 'test-plans',
    agentJobs: 'test-agent-jobs',
    epicWorkflows: 'test-epic-workflows',
    apps: 'test-apps',
    attentionItems: 'test-attention-items',
  },
}));

import { app } from '../index';

const VALID_CONCEPT_PLAN = {
  uiBearing: true,
  complexity: 'medium',
  artifacts: [
    { kind: 'prd', depth: 'full' },
    { kind: 'ux', depth: 'light', dependsOn: ['prd'] },
    { kind: 'architecture', depth: 'full', dependsOn: ['prd', 'ux'] },
  ],
  gate: 'strict',
  rationale: 'UI app, multiple subsystems.',
};

function planRow() {
  return {
    planId: 'plan-1',
    name: 'pong',
    workingDir: '/home/ubuntu/projects/pong',
    status: 'concept',
    conceptRouteJobId: 'route-job-1',
  };
}

function routeJob(conceptPlanJson: string, status = 'COMPLETED') {
  return {
    jobId: 'route-job-1',
    status,
    workingDir: '/home/ubuntu/projects/pong',
    variables: { CONCEPT_PLAN_JSON: conceptPlanJson },
  };
}

/** Smart send mock: Get on plans→plan, Get on agent-jobs→job, Update→ack. */
function wireSend(plan: unknown, job: unknown) {
  sendMock.mockImplementation(async (cmd: { input?: Record<string, unknown> }) => {
    const input = cmd.input || {};
    const table = String(input.TableName || '');
    if (input.UpdateExpression) return {}; // updatePlanFields ack
    if (table.includes('agent-job')) return { Item: job };
    if (table.includes('plan')) return { Item: plan };
    return {};
  });
}

async function applyConceptPlan(planId: string) {
  return app.request(`/api/plans/${planId}/apply-concept-plan`, { method: 'POST' });
}

beforeEach(() => {
  sendMock.mockReset();
});

describe('POST /api/plans/:id/apply-concept-plan (Concept v2 integration)', () => {
  it('happy path — persists the validated conceptPlan + returns it', async () => {
    wireSend(planRow(), routeJob(JSON.stringify(VALID_CONCEPT_PLAN)));
    const res = await applyConceptPlan('plan-1');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { conceptPlan: { gate: string } };
    expect(body.conceptPlan.gate).toBe('strict');
    // An UpdateCommand (updatePlanFields) was issued.
    const sawUpdate = sendMock.mock.calls.some((c) => c[0]?.input?.UpdateExpression);
    expect(sawUpdate).toBe(true);
  });

  it('parse failure — invalid CONCEPT_PLAN_JSON → 400 PARSE_FAILED', async () => {
    wireSend(planRow(), routeJob('not json'));
    const res = await applyConceptPlan('plan-1');
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('PARSE_FAILED');
  });

  it('schema failure — uiBearing plan missing ux → 400 PARSE_FAILED', async () => {
    const bad = { ...VALID_CONCEPT_PLAN, artifacts: [{ kind: 'prd', depth: 'full' }] };
    wireSend(planRow(), routeJob(JSON.stringify(bad)));
    const res = await applyConceptPlan('plan-1');
    expect(res.status).toBe(400);
  });

  it('job not COMPLETED → rejected', async () => {
    wireSend(planRow(), routeJob(JSON.stringify(VALID_CONCEPT_PLAN), 'RUNNING'));
    const res = await applyConceptPlan('plan-1');
    expect(res.status).toBeGreaterThanOrEqual(400);
  });
});
