import { describe, it, expect, vi, beforeEach } from 'vitest';

const { sendMock } = vi.hoisted(() => ({ sendMock: vi.fn() }));

vi.mock('../../dynamo-client', () => ({
  docClient: { send: sendMock },
  TABLE_NAMES: {
    agentJobs: 'test-agent-jobs',
    projects: 'test-projects',
    costs: 'test-costs',
    resources: 'test-resources',
    audits: 'test-audits',
    schedules: 'test-schedules',
    users: 'test-users',
    alerts: 'test-alerts',
    agentEvents: 'test-agent-events',
    epicWorkflows: 'test-epic-workflows',
    projectRegistry: 'test-project-registry',
    partyProjects: 'test-party-projects',
    partySessions: 'test-party-sessions',
    plans: 'test-plans',
  },
}));

import {
  createPlan,
  getPlanByName,
  toPlanSummary,
  listPlansByApp,
  getActivePlanForApp,
  addEpicToPlan,
  transitionPlanStatus,
  writeP3QaVerdict,
  clearP3QaForRerun,
} from '../plan-repository';
import type { Plan, PlanStatus } from '../../types/plan';
import { planNameSchema } from '../../schemas/plan-schema';

// The runtime status schema (planStatusSchema / PLAN_LEGAL_TRANSITIONS) carries
// 'abandoned' as a terminal status, but the PlanStatus TS type in types/plan.ts
// still lags it. Cast until the type catches up (a no-op once 'abandoned' lands).
const ABANDONED = 'abandoned' as PlanStatus;

function basePlan(overrides: Partial<Plan> = {}): Plan {
  return {
    planId: 'plan-1',
    name: 'pong-classic',
    intent: 'Create a Pong game',
    description: '',
    status: 'concept',
    epicIds: [],
    workingDir: '/home/ubuntu/projects/pong-classic',
    executionMode: 'pipeline',
    totalCostUsd: 0,
    totalStories: 0,
    doneStories: 0,
    createdAt: '2026-04-21T00:00:00.000Z',
    updatedAt: '2026-04-21T00:00:00.000Z',
    createdBy: 'tester',
    ...overrides,
  };
}

describe('planNameSchema', () => {
  it.each(['pong-classic', 'my-cool-app', 'abc', 'a-b-c-d', 'a1-b2', 'a'.repeat(41)])(
    'accepts valid name "%s"',
    (name) => {
      expect(planNameSchema.safeParse(name).success).toBe(true);
    },
  );

  it.each([
    ['PONG', 'uppercase'],
    ['1starts-with-digit', 'starts with digit'],
    ['ab', 'too short'],
    ['a'.repeat(42), 'too long'],
    ['has_underscore', 'underscore forbidden'],
    ['has spaces', 'space forbidden'],
    ['-leading-hyphen', 'leading hyphen'],
    ['', 'empty'],
  ])('rejects invalid name "%s" (%s)', (name) => {
    expect(planNameSchema.safeParse(name).success).toBe(false);
  });
});

describe('createPlan', () => {
  beforeEach(() => {
    sendMock.mockReset();
  });

  it('creates plan when name is free', async () => {
    sendMock.mockResolvedValueOnce({ Items: [] }); // getPlanByName scan
    sendMock.mockResolvedValueOnce({}); // PutCommand

    const plan = basePlan();
    const saved = await createPlan(plan);

    expect(saved).toEqual(plan);
    expect(sendMock).toHaveBeenCalledTimes(2);
  });

  it('rejects when another non-archived plan already holds the name', async () => {
    const existing = basePlan({ planId: 'plan-existing' });
    sendMock.mockResolvedValueOnce({ Items: [existing] });

    await expect(createPlan(basePlan({ planId: 'plan-new' }))).rejects.toMatchObject({
      code: 'NAME_TAKEN',
      statusCode: 409,
    });
    expect(sendMock).toHaveBeenCalledTimes(1); // no Put
  });

  it('allows reusing a name held by an archived plan', async () => {
    const archived = basePlan({ planId: 'plan-old', status: 'archived' });
    sendMock.mockResolvedValueOnce({ Items: [archived] }); // getPlanByName returns archived
    sendMock.mockResolvedValueOnce({}); // PutCommand succeeds

    const newPlan = basePlan({ planId: 'plan-new' });
    const saved = await createPlan(newPlan);

    expect(saved.planId).toBe('plan-new');
    expect(sendMock).toHaveBeenCalledTimes(2);
  });
});

describe('getPlanByName', () => {
  beforeEach(() => {
    sendMock.mockReset();
  });

  it('returns null when no plan has that name', async () => {
    sendMock.mockResolvedValueOnce({ Items: [] });
    expect(await getPlanByName('nope')).toBeNull();
  });

  it('prefers non-archived over archived when both exist', async () => {
    const archived = basePlan({ planId: 'old', status: 'archived' });
    const active = basePlan({ planId: 'new', status: 'developing' });
    sendMock.mockResolvedValueOnce({ Items: [archived, active] });

    const result = await getPlanByName('pong-classic');
    expect(result?.planId).toBe('new');
  });

  it('returns archived match when it is the only one', async () => {
    const archived = basePlan({ planId: 'only', status: 'archived' });
    sendMock.mockResolvedValueOnce({ Items: [archived] });

    const result = await getPlanByName('pong-classic');
    expect(result?.planId).toBe('only');
  });
});

// ─────────────────────────────────────────────────────────────────────
// App/Plan v1 — App-aware queries
// ─────────────────────────────────────────────────────────────────────

function extractInput(command: unknown): Record<string, unknown> {
  return (command as { input: Record<string, unknown> }).input;
}

describe('listPlansByApp (App/Plan v1)', () => {
  beforeEach(() => {
    sendMock.mockReset();
  });

  it('returns Plans in chronological order via GSI', async () => {
    const p1 = basePlan({ planId: 'p1', appId: 'dino3', createdAt: '2026-04-01T00:00:00.000Z' });
    const p2 = basePlan({ planId: 'p2', appId: 'dino3', createdAt: '2026-04-02T00:00:00.000Z' });
    sendMock.mockResolvedValueOnce({ Items: [p1, p2] });

    const result = await listPlansByApp('dino3');
    expect(result.map((p) => p.planId)).toEqual(['p1', 'p2']);
    expect(sendMock).toHaveBeenCalledTimes(1);
  });

  it('falls back to Scan when GSI is missing (ValidationException)', async () => {
    const err: Error = Object.assign(new Error('missing index'), { name: 'ValidationException' });
    sendMock.mockRejectedValueOnce(err);

    const p1 = basePlan({ planId: 'p1', appId: 'dino3', createdAt: '2026-04-02T00:00:00.000Z' });
    const p2 = basePlan({ planId: 'p2', appId: 'dino3', createdAt: '2026-04-01T00:00:00.000Z' });
    sendMock.mockResolvedValueOnce({ Items: [p1, p2] });

    const result = await listPlansByApp('dino3');
    expect(result.map((p) => p.planId)).toEqual(['p2', 'p1']); // sorted ascending after fallback
  });
});

describe('getActivePlanForApp (App/Plan v1)', () => {
  beforeEach(() => {
    sendMock.mockReset();
  });

  it('returns the first non-terminal Plan', async () => {
    sendMock.mockResolvedValueOnce({
      Items: [
        basePlan({ planId: 'p1', appId: 'dino3', status: 'delivered' }),
        basePlan({ planId: 'p2', appId: 'dino3', status: 'developing' }),
      ],
    });
    const active = await getActivePlanForApp('dino3');
    expect(active?.planId).toBe('p2');
  });

  it('returns null when all Plans are terminal', async () => {
    sendMock.mockResolvedValueOnce({
      Items: [
        basePlan({ planId: 'p1', appId: 'dino3', status: 'delivered' }),
        basePlan({ planId: 'p2', appId: 'dino3', status: ABANDONED }),
      ],
    });
    expect(await getActivePlanForApp('dino3')).toBe(null);
  });

  it('returns null when no Plans exist for the App', async () => {
    sendMock.mockResolvedValueOnce({ Items: [] });
    expect(await getActivePlanForApp('dino3')).toBe(null);
  });

  it('treats concept/developing/review as non-terminal', async () => {
    for (const status of ['concept', 'developing', 'review'] as const) {
      sendMock.mockReset();
      sendMock.mockResolvedValueOnce({
        Items: [basePlan({ planId: 'p1', appId: 'dino3', status })],
      });
      const active = await getActivePlanForApp('dino3');
      expect(active?.status).toBe(status);
    }
  });
});

describe('addEpicToPlan (App/Plan v1)', () => {
  beforeEach(() => {
    sendMock.mockReset();
  });

  it('returns updated Plan with new epicId appended', async () => {
    sendMock.mockResolvedValueOnce({ Attributes: basePlan({ epicIds: ['e1'] }) });
    const result = await addEpicToPlan('plan-1', 'e1');
    expect(result.epicIds).toEqual(['e1']);
    expect(sendMock).toHaveBeenCalledTimes(1);
  });

  it('throws PLAN_NOT_FOUND on conditional check failure', async () => {
    const err: Error = Object.assign(new Error('not found'), {
      name: 'ConditionalCheckFailedException',
    });
    sendMock.mockRejectedValueOnce(err);
    await expect(addEpicToPlan('missing', 'e1')).rejects.toMatchObject({
      code: 'PLAN_NOT_FOUND',
      statusCode: 404,
    });
  });
});

describe('transitionPlanStatus (App/Plan v1)', () => {
  beforeEach(() => {
    sendMock.mockReset();
  });

  it('allows concept → developing', async () => {
    sendMock
      .mockResolvedValueOnce({ Item: basePlan({ status: 'concept' }) })
      .mockResolvedValueOnce({}); // updatePlanFields

    const result = await transitionPlanStatus('plan-1', 'developing');
    expect(result.status).toBe('developing');
  });

  it('allows any non-terminal → abandoned', async () => {
    sendMock
      .mockResolvedValueOnce({ Item: basePlan({ status: 'developing' }) })
      .mockResolvedValueOnce({});
    expect((await transitionPlanStatus('plan-1', ABANDONED)).status).toBe('abandoned');

    sendMock.mockReset();
    sendMock
      .mockResolvedValueOnce({ Item: basePlan({ status: 'review' }) })
      .mockResolvedValueOnce({});
    expect((await transitionPlanStatus('plan-1', ABANDONED)).status).toBe('abandoned');
  });

  it('rejects illegal transitions (delivered is terminal)', async () => {
    sendMock.mockResolvedValueOnce({ Item: basePlan({ status: 'delivered' }) });
    await expect(transitionPlanStatus('plan-1', 'developing')).rejects.toMatchObject({
      code: 'ILLEGAL_TRANSITION',
      statusCode: 409,
    });
  });

  it('rejects illegal transitions (abandoned is terminal)', async () => {
    sendMock.mockResolvedValueOnce({ Item: basePlan({ status: ABANDONED }) });
    await expect(transitionPlanStatus('plan-1', 'developing')).rejects.toMatchObject({
      code: 'ILLEGAL_TRANSITION',
    });
  });

  it('throws PLAN_NOT_FOUND when Plan does not exist', async () => {
    sendMock.mockResolvedValueOnce({ Item: undefined });
    await expect(transitionPlanStatus('missing', 'developing')).rejects.toMatchObject({
      code: 'PLAN_NOT_FOUND',
      statusCode: 404,
    });
  });
});

// ─────────────────────────────────────────────────────────────────────
// P3_QA_REVIEW honest-gate (Slice B) — qaVerifiedAt lifecycle
// ─────────────────────────────────────────────────────────────────────

const QA_SHA = 'b'.repeat(40);
function verdict(over: Record<string, unknown> = {}) {
  return {
    status: 'pass',
    blocking: false,
    ranAtSha: QA_SHA,
    journeys: [],
    vqa: [],
    wiring: { orphanModules: [], blocking: false },
    ...over,
  } as NonNullable<Plan['p3QaVerdict']>;
}

/** Grab the UpdateExpression string from the last UpdateCommand sent. */
function lastUpdateExpr(): string {
  const calls = sendMock.mock.calls.filter(
    ([c]) => (c as { constructor: { name: string } }).constructor.name === 'UpdateCommand',
  );
  const last = calls[calls.length - 1]?.[0] as
    | { input?: { UpdateExpression?: string } }
    | undefined;
  return String(last?.input?.UpdateExpression ?? '');
}

describe('writeP3QaVerdict (Slice B qaVerifiedAt)', () => {
  beforeEach(() => {
    sendMock.mockReset();
  });

  it('non-blocking verdict + matching SHA → SETs qaVerifiedAt', async () => {
    sendMock.mockResolvedValueOnce({ Item: basePlan({ qaCommitSha: QA_SHA }) }); // getPlanById
    sendMock.mockResolvedValueOnce({}); // UpdateCommand
    const res = await writeP3QaVerdict('plan-1', verdict());
    expect(res.written).toBe(true);
    const expr = lastUpdateExpr();
    expect(expr).toContain('qaVerifiedAt = :now');
    expect(expr).not.toContain('REMOVE');
  });

  it('blocking verdict → REMOVEs qaVerifiedAt, never SETs it', async () => {
    sendMock.mockResolvedValueOnce({ Item: basePlan({ qaCommitSha: QA_SHA }) });
    sendMock.mockResolvedValueOnce({});
    const res = await writeP3QaVerdict('plan-1', verdict({ blocking: true, status: 'fail' }));
    expect(res.written).toBe(true);
    const expr = lastUpdateExpr();
    expect(expr).toContain('REMOVE qaVerifiedAt');
    expect(expr).not.toContain('qaVerifiedAt = :now');
  });

  it('stale SHA → does NOT write (no qaVerifiedAt stamp)', async () => {
    sendMock.mockResolvedValueOnce({ Item: basePlan({ qaCommitSha: 'c'.repeat(40) }) });
    const res = await writeP3QaVerdict('plan-1', verdict()); // ranAtSha = QA_SHA ≠ plan sha
    expect(res).toEqual({ written: false, reason: 'stale-sha' });
    expect(sendMock).toHaveBeenCalledTimes(1); // only the getPlanById read
  });

  it('human already decided → leaves the row untouched', async () => {
    sendMock.mockResolvedValueOnce({
      Item: basePlan({
        qaCommitSha: QA_SHA,
        p3QaVerdict: verdict({ decidedAt: '2026-07-04T00:00:00Z', decision: 'approved' }),
      }),
    });
    const res = await writeP3QaVerdict('plan-1', verdict());
    expect(res).toEqual({ written: false, reason: 'human-decided' });
    expect(sendMock).toHaveBeenCalledTimes(1);
  });
});

describe('clearP3QaForRerun (Slice B)', () => {
  beforeEach(() => {
    sendMock.mockReset();
  });

  it('REMOVEs qaVerifiedAt along with the rest of the QA pin', async () => {
    sendMock.mockResolvedValueOnce({});
    await clearP3QaForRerun('plan-1');
    const expr = lastUpdateExpr();
    for (const field of [
      'p3QaJobId',
      'p3QaVerdict',
      'devDeployJobId',
      'qaCommitSha',
      'qaVerifiedAt',
    ]) {
      expect(expr).toContain(field);
    }
  });
});

describe('toPlanSummary', () => {
  it('projects only the fields the list view needs', () => {
    const plan = basePlan({
      totalCostUsd: 1.42,
      totalStories: 6,
      doneStories: 4,
      deployUrl: 'https://futurator.ai/apps/pong/',
    });
    const summary = toPlanSummary(plan);
    expect(summary).toEqual({
      planId: plan.planId,
      name: plan.name,
      intent: plan.intent,
      status: plan.status,
      totalStories: 6,
      doneStories: 4,
      totalCostUsd: 1.42,
      createdAt: plan.createdAt,
      updatedAt: plan.updatedAt,
      archivedAt: undefined,
      deployUrl: plan.deployUrl,
    });
  });
});
