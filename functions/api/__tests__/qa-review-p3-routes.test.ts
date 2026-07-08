/**
 * qa-review-p3-routes.test.ts — QA-Review W2 plan-keyed endpoints.
 *
 * Hermetic coverage of the three deployed-app QA routes:
 *   GET  /api/plans/:id/qa-review-p3
 *     1. flag off        → { enabled:false, report:null } (dark read)
 *     2. flag shadow     → { enabled:false, report:null } (shadow computes, never surfaces)
 *     3. flag on, no verdict → { enabled:true, report:null }
 *     4. flag on + verdict   → shaped report (status/journeys/wiring) + raw verdict
 *   POST /api/plans/:id/qa/approve
 *     5. flag off        → 404 QA_REVIEW_DISABLED
 *     6. blocking verdict→ 400 QA_BLOCKING
 *     7. already decided → 409 ALREADY_DECIDED
 *     8. happy path      → 200, decision persisted with approvedSha === ranAtSha
 *   POST /api/plans/:id/qa/send-back
 *     9. mints fix stories, flips → fixing, RESETS QA state (REMOVE p3QaJobId,
 *        p3QaVerdict, devDeployJobId, qaCommitSha) so the loop re-runs fresh
 *
 * DDB + auth fully mocked; mirrors party-assess-route.test.ts.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../../shared/auth-middleware', () => ({
  authMiddleware: vi.fn(
    async (c: { set: (k: string, v: unknown) => void }, next: () => Promise<void>) => {
      c.set('user', { userId: 'u1', email: 'ric@example.com', name: 'Ric' });
      await next();
    },
  ),
}));

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

import { app } from '../index';

const PLAN_ID = '0372760b-e410-4288-9944-046cd9d5f0ed';
const SHA = 'a'.repeat(40);

function verdict(over: Record<string, unknown> = {}) {
  return {
    status: 'fail',
    blocking: true,
    ranAtSha: SHA,
    journeys: [
      {
        id: 'j1',
        title: 'Move',
        acRefs: ['ac1'],
        verdict: 'fail',
        steps: [
          {
            label: 's',
            action: 'press ArrowUp',
            deterministic: {
              assertion: 'moves',
              passed: false,
              detail: 'window.__harness seam not mounted on the served app',
            },
          },
        ],
      },
    ],
    vqa: [],
    wiring: { orphanModules: ['src/game/ghost-ai.ts'], blocking: true },
    ...over,
  };
}

function plan(over: Record<string, unknown> = {}) {
  return {
    planId: PLAN_ID,
    name: 'pacman3-746c20',
    appId: 'pacman3-746c20',
    status: 'review',
    epicIds: [],
    workingDir: '/home/ubuntu/projects/pacman3-746c20',
    devUrl: 'https://dev.futurator.ai/pacman3-746c20/',
    qaCommitSha: SHA,
    createdBy: 'u1',
    ...over,
  };
}

/** Wire sendMock: GetCommand → the plan row; everything else resolves {}. */
function ddbReturns(planRow: Record<string, unknown> | null) {
  sendMock.mockReset();
  sendMock.mockImplementation(
    (cmd: { constructor: { name: string }; input?: Record<string, unknown> }) => {
      const kind = cmd.constructor.name;
      if (kind === 'GetCommand') return Promise.resolve({ Item: planRow ?? undefined });
      return Promise.resolve({});
    },
  );
}

const ORIGINAL_FLAG = process.env.P3_QA_REVIEW;
afterEach(() => {
  if (ORIGINAL_FLAG === undefined) delete process.env.P3_QA_REVIEW;
  else process.env.P3_QA_REVIEW = ORIGINAL_FLAG;
});
beforeEach(() => {
  process.env.P3_QA_REVIEW = 'on';
});

describe('GET /api/plans/:id/qa-review-p3', () => {
  it('flag off → dark read: enabled:false, report:null', async () => {
    process.env.P3_QA_REVIEW = 'off';
    ddbReturns(plan({ p3QaVerdict: verdict() }));
    const res = await app.request(`/api/plans/${PLAN_ID}/qa-review-p3`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ enabled: false, report: null });
  });

  it('flag shadow → computes-but-never-surfaces: enabled:false', async () => {
    process.env.P3_QA_REVIEW = 'shadow';
    ddbReturns(plan({ p3QaVerdict: verdict() }));
    const res = await app.request(`/api/plans/${PLAN_ID}/qa-review-p3`);
    expect((await res.json()).enabled).toBe(false);
  });

  it('flag on, no verdict → enabled:true, report:null', async () => {
    ddbReturns(plan());
    const res = await app.request(`/api/plans/${PLAN_ID}/qa-review-p3`);
    expect(await res.json()).toEqual({ enabled: true, report: null });
  });

  it('flag on + blocking verdict → shaped failed report', async () => {
    ddbReturns(plan({ p3QaVerdict: verdict() }));
    const res = await app.request(`/api/plans/${PLAN_ID}/qa-review-p3`);
    const body = await res.json();
    expect(body.enabled).toBe(true);
    expect(body.report.status).toBe('failed');
    expect(body.report.qaCommitSha).toBe(SHA);
    expect(body.report.journeys).toHaveLength(1);
    expect(body.report.wiring.orphanModules).toContain('src/game/ghost-ai.ts');
  });

  it('Slice B — passes plan.qaVerifiedAt through onto the report', async () => {
    const VERIFIED = '2026-07-08T12:00:00.000Z';
    ddbReturns(
      plan({ qaVerifiedAt: VERIFIED, p3QaVerdict: verdict({ blocking: false, status: 'pass' }) }),
    );
    const res = await app.request(`/api/plans/${PLAN_ID}/qa-review-p3`);
    const body = await res.json();
    expect(body.report.qaVerifiedAt).toBe(VERIFIED);
  });

  it('Slice B — absent qaVerifiedAt → report.qaVerifiedAt is undefined (not verified)', async () => {
    ddbReturns(plan({ p3QaVerdict: verdict({ blocking: false, status: 'pass' }) }));
    const res = await app.request(`/api/plans/${PLAN_ID}/qa-review-p3`);
    const body = await res.json();
    expect(body.report.qaVerifiedAt).toBeUndefined();
  });
});

// ─────────────────────────────────────────────────────────────────────
// Slice B — promote SOFT-BLOCK on the readiness rule (isDeliverable)
// ─────────────────────────────────────────────────────────────────────
describe('POST /api/plans/:id/promote (Slice B QA soft-block)', () => {
  function promoteReq() {
    return app.request(`/api/plans/${PLAN_ID}/promote`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ to: 'staging' }),
    });
  }

  it('no qaVerifiedAt and no approval → 400 QA_NOT_VERIFIED', async () => {
    // devUrl present (ladder gate ok), blocking verdict, no qaVerifiedAt.
    ddbReturns(plan({ p3QaVerdict: verdict() }));
    const res = await promoteReq();
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe('QA_NOT_VERIFIED');
  });

  it('qaVerifiedAt present (auto-verified) → promote proceeds (201)', async () => {
    ddbReturns(
      plan({
        qaVerifiedAt: '2026-07-08T12:00:00.000Z',
        p3QaVerdict: verdict({ blocking: false, status: 'pass' }),
      }),
    );
    const res = await promoteReq();
    expect(res.status).toBe(201);
  });

  it('operator Approve (decision approved, pinned) → promote proceeds even without qaVerifiedAt', async () => {
    ddbReturns(
      plan({
        p3QaVerdict: verdict({
          blocking: false,
          status: 'pass',
          decision: 'approved',
          approvedSha: SHA,
          decidedAt: '2026-07-08T00:00:00Z',
        }),
      }),
    );
    const res = await promoteReq();
    expect(res.status).toBe(201);
  });

  it('flag off → soft-block bypassed entirely (201)', async () => {
    process.env.P3_QA_REVIEW = 'off';
    ddbReturns(plan({ p3QaVerdict: verdict() }));
    const res = await promoteReq();
    expect(res.status).toBe(201);
  });
});

describe('POST /api/plans/:id/qa/approve', () => {
  it('flag off → 404 QA_REVIEW_DISABLED', async () => {
    process.env.P3_QA_REVIEW = 'off';
    ddbReturns(plan({ p3QaVerdict: verdict({ blocking: false, status: 'pass' }) }));
    const res = await app.request(`/api/plans/${PLAN_ID}/qa/approve`, { method: 'POST' });
    expect(res.status).toBe(404);
  });

  it('blocking verdict → 400 QA_BLOCKING (a red verdict is never approvable)', async () => {
    ddbReturns(plan({ p3QaVerdict: verdict() }));
    const res = await app.request(`/api/plans/${PLAN_ID}/qa/approve`, { method: 'POST' });
    expect(res.status).toBe(400);
  });

  it('already decided → 409 ALREADY_DECIDED', async () => {
    ddbReturns(
      plan({
        p3QaVerdict: verdict({
          blocking: false,
          status: 'pass',
          decidedAt: '2026-07-04T00:00:00Z',
          decision: 'approved',
        }),
      }),
    );
    const res = await app.request(`/api/plans/${PLAN_ID}/qa/approve`, { method: 'POST' });
    expect(res.status).toBe(409);
  });

  it('happy path → 200, decision pinned to the ranAtSha', async () => {
    ddbReturns(plan({ p3QaVerdict: verdict({ blocking: false, status: 'pass' }) }));
    const res = await app.request(`/api/plans/${PLAN_ID}/qa/approve`, { method: 'POST' });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.verdict.decision).toBe('approved');
    expect(body.verdict.approvedSha).toBe(SHA);
    // the decision was persisted (an UpdateCommand carrying p3QaVerdict)
    const updates = sendMock.mock.calls.filter(([c]) => c.constructor.name === 'UpdateCommand');
    expect(updates.length).toBeGreaterThan(0);
  });
});

describe('POST /api/plans/:id/qa/send-back', () => {
  it('mints fix stories, flips → fixing, and RESETS the QA state for a fresh loop', async () => {
    ddbReturns(plan({ p3QaVerdict: verdict() }));
    const res = await app.request(`/api/plans/${PLAN_ID}/qa/send-back`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ note: 'seam missing' }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    // seam-not-mounted + orphan → seam story + orphan story
    expect(body.mintedStories).toBeGreaterThanOrEqual(1);

    // The reset MUST clear the whole pin so the fixed commit re-deploys:
    const updateInputs = sendMock.mock.calls
      .filter(([c]) => c.constructor.name === 'UpdateCommand')
      .map(([c]) => String(c.input?.UpdateExpression ?? ''));
    const removeExpr = updateInputs.find((e) => e.includes('REMOVE'));
    expect(removeExpr).toBeDefined();
    for (const field of ['p3QaJobId', 'p3QaVerdict', 'devDeployJobId', 'qaCommitSha']) {
      expect(removeExpr).toContain(field);
    }
    // status flip to fixing persisted
    const statusUpdate = sendMock.mock.calls.find(
      ([c]) =>
        c.constructor.name === 'UpdateCommand' && JSON.stringify(c.input ?? {}).includes('fixing'),
    );
    expect(statusUpdate).toBeDefined();
  });

  it('already decided → 409 (a human decision is final)', async () => {
    ddbReturns(
      plan({ p3QaVerdict: verdict({ decidedAt: '2026-07-04T00:00:00Z', decision: 'sent-back' }) }),
    );
    const res = await app.request(`/api/plans/${PLAN_ID}/qa/send-back`, { method: 'POST' });
    expect(res.status).toBe(409);
  });
});

describe('POST /api/plans/:id/stories/:storyId/retry', () => {
  const STORY = 'f594a817-791f-4548-8491-ea8e01b891f3';
  function storyRow(over: Record<string, unknown> = {}) {
    return { storyId: STORY, planId: PLAN_ID, state: 'failed', title: 'Assemble', ...over };
  }
  function ddbStoryReturns(
    row: Record<string, unknown> | null,
    jobRow?: Record<string, unknown> | null,
  ) {
    sendMock.mockReset();
    sendMock.mockImplementation(
      (cmd: { constructor: { name: string }; input?: Record<string, unknown> }) => {
        if (cmd.constructor.name === 'GetCommand') {
          const key = (cmd.input as { Key?: Record<string, unknown> })?.Key ?? {};
          if ('storyId' in key) return Promise.resolve({ Item: row ?? undefined });
          if ('jobId' in key) return Promise.resolve({ Item: jobRow ?? undefined });
          return Promise.resolve({ Item: plan() });
        }
        return Promise.resolve({});
      },
    );
  }

  it('failed story → reset to ready (UpdateCommand with the retryable-state condition)', async () => {
    ddbStoryReturns(storyRow());
    const res = await app.request(`/api/plans/${PLAN_ID}/stories/${STORY}/retry`, {
      method: 'POST',
    });
    expect(res.status).toBe(200);
    expect((await res.json()).state).toBe('ready');
    const upd = sendMock.mock.calls.find(([c]) => c.constructor.name === 'UpdateCommand');
    expect(String(upd?.[0].input?.UpdateExpression)).toMatch(
      /REMOVE claimOwner, claimToken, claimExpiresAt, jobId/,
    );
  });

  it('done story → 400', async () => {
    ddbStoryReturns(storyRow({ state: 'done' }));
    const res = await app.request(`/api/plans/${PLAN_ID}/stories/${STORY}/retry`, {
      method: 'POST',
    });
    expect(res.status).toBe(400);
  });

  it('actively-running claimed story (fresh heartbeat) → 409, never double-runs', async () => {
    ddbStoryReturns(
      storyRow({
        state: 'claimed',
        jobId: 'live-job',
        claimExpiresAt: new Date(Date.now() + 60_000).toISOString(),
      }),
      { jobId: 'live-job', status: 'RUNNING', lastHeartbeatAt: new Date().toISOString() },
    );
    const res = await app.request(`/api/plans/${PLAN_ID}/stories/${STORY}/retry`, {
      method: 'POST',
    });
    expect(res.status).toBe(409);
  });

  it('claimed story with a DEAD job (STALE) → released to ready', async () => {
    ddbStoryReturns(storyRow({ state: 'claimed', jobId: 'dead-job' }), {
      jobId: 'dead-job',
      status: 'STALE',
      updatedAt: new Date(Date.now() - 10 * 60_000).toISOString(),
    });
    const res = await app.request(`/api/plans/${PLAN_ID}/stories/${STORY}/retry`, {
      method: 'POST',
    });
    expect(res.status).toBe(200);
  });
});
