// Tests for timing-aggregator.ts (Story 1.8.6)
//
// Fixture: 6-plan cohort across 2 cohort keys.
// Asserts:
//   - Correct cohortKey assignment per plan (templateType#planKind#bucket).
//   - Correct median / p90 computed across sampled plans.
//   - Cohorts with < 5 valid samples are NOT written (skipped).
//   - upsertCohort is called exactly once per qualifying cohort.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { App } from '../../shared/types/app';
import type { Plan } from '../../shared/types/plan';
import type { TimerSlice } from '../../shared/timer/types';

// ── Mocks ─────────────────────────────────────────────────────────────────────

const mocks = vi.hoisted(() => ({
  listApps: vi.fn(),
  listPlansByApp: vi.fn(),
  sliceForPlan: vi.fn(),
  aggregateByCategory: vi.fn(),
  upsertCohort: vi.fn(),
  log: vi.fn(),
}));

vi.mock('../../shared/repositories/app-repository', () => ({
  listApps: mocks.listApps,
}));
vi.mock('../../shared/repositories/plan-repository', () => ({
  listPlansByApp: mocks.listPlansByApp,
}));
vi.mock('../../shared/timer/slicer', () => ({
  sliceForPlan: mocks.sliceForPlan,
}));
vi.mock('../../shared/timer/aggregator', () => ({
  aggregateByCategory: mocks.aggregateByCategory,
}));
vi.mock('../../shared/repositories/timing-summary-repository', () => ({
  upsertCohort: mocks.upsertCohort,
  getCohortByKey: vi.fn(),
  listAllCohorts: vi.fn(),
}));
vi.mock('../../shared/logger', () => ({
  log: mocks.log,
}));

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeApp(appId: string, boilerplateType: string = 'nextjs'): App {
  return {
    appId,
    displayName: appId,
    workingDir: `/home/ubuntu/projects/${appId}`,
    executionMode: 'pipeline',
    currentlyDeployedPlanId: null,
    deployJobIds: [],
    boilerplateType: boilerplateType as App['boilerplateType'],
    workingTreeStatus: 'clean',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
}

function makePlan(
  planId: string,
  appId: string,
  status: string = 'delivered',
  epicCount: number = 2,
  kind: string = 'initial',
): Plan & { appId: string; kind: string } {
  return {
    planId,
    name: planId,
    intent: 'test',
    description: '',
    status: status as Plan['status'],
    epicIds: Array.from({ length: epicCount }, (_, i) => `epic-${i}`),
    workingDir: `/home/ubuntu/projects/${appId}`,
    executionMode: 'pipeline',
    totalCostUsd: 0,
    totalStories: 0,
    doneStories: 0,
    createdAt: '2026-04-01T00:00:00.000Z',
    updatedAt: '2026-04-01T01:00:00.000Z',
    createdBy: 'test',
    // DDB-stored but not typed on Plan interface
    appId,
    kind,
  };
}

/** Build a minimal AggregationResult shape with a single 'review' ms value. */
function makeAgg(reviewMs: number) {
  const zero = { totalMs: 0, count: 0 };
  return {
    byCategory: {
      dev: zero,
      'test-author': zero,
      'test-execute': zero,
      review: { totalMs: reviewMs, count: 3 },
      qa: zero,
      po: zero,
      architect: zero,
      compile: zero,
      'human-wait': zero,
      'machine-wait': zero,
      git: zero,
      bootstrap: zero,
      fix: zero,
      idle: zero,
      unattributed: zero,
    },
    totalMs: reviewMs,
  };
}

/** Build a minimal TimerSlice array with given startedAt/endedAt (for wall-clock). */
function makeSlices(startedAtMs: number, durationMs: number): TimerSlice[] {
  const startedAt = new Date(startedAtMs).toISOString();
  const endedAt = new Date(startedAtMs + durationMs).toISOString();
  return [
    {
      jobId: 'j1',
      eventSeq: '0001',
      category: 'review',
      startedAt,
      endedAt,
      durationMs,
      agentRole: 'reviewer',
      eventType: 'text_delta',
    },
  ];
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('timing-aggregator handler', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.upsertCohort.mockResolvedValue(undefined);
  });

  it('assigns correct cohortKey and upserts cohort for qualifying group', async () => {
    // 6 delivered plans on app-A with epicCount=2, kind=initial
    // cohortKey = nextjs#initial#1  (epicCount 2 → bucket = floor(2/2)*2+1 = 3 — wait: floor(2/2)*2+1 = 1*2+1=3)
    // Actually: bucket = floor(2/2)*2+1 = 1*2+1 = 3
    const app = makeApp('app-a', 'nextjs');
    mocks.listApps.mockResolvedValue([app]);

    const plans = Array.from({ length: 6 }, (_, i) =>
      makePlan(`plan-${i}`, 'app-a', 'delivered', 2, 'initial'),
    );
    mocks.listPlansByApp.mockResolvedValue(plans);

    // Each plan has 60_000ms duration and 20_000ms review time
    const BASE_TIME = new Date('2026-04-01T00:00:00.000Z').getTime();
    mocks.sliceForPlan.mockImplementation(async () => {
      return makeSlices(BASE_TIME, 60_000);
    });
    mocks.aggregateByCategory.mockImplementation(() => {
      return makeAgg(20_000);
    });

    const { handler } = await import('../timing-aggregator');
    await handler();

    // One cohort group with 6 samples — should be written
    expect(mocks.upsertCohort).toHaveBeenCalledTimes(1);

    const written = mocks.upsertCohort.mock.calls[0][0] as {
      cohortKey: string;
      samples: number;
      medianMs: number;
      p90Ms: number;
      byCategory: Record<string, { medianMs: number; p90Ms: number; count: number }>;
      lastSampleIds: string[];
    };
    // epicCount=2 → bucket = floor(2/2)*2+1 = 3
    expect(written.cohortKey).toBe('nextjs#initial#3');
    expect(written.samples).toBe(6);
    // All plans have 60_000ms duration → median = p90 = 60_000
    expect(written.medianMs).toBe(60_000);
    expect(written.p90Ms).toBe(60_000);
    // Per-category review: all plans = 20_000ms → median = 20_000
    expect(written.byCategory['review']?.medianMs).toBe(20_000);
    // lastSampleIds should have ≤20 entries
    expect(written.lastSampleIds.length).toBeLessThanOrEqual(20);
  });

  it('skips a cohort with fewer than 5 samples', async () => {
    const app = makeApp('app-b', 'nextjs');
    mocks.listApps.mockResolvedValue([app]);

    // Only 3 delivered plans — below minSamples=5
    const plans = Array.from({ length: 3 }, (_, i) =>
      makePlan(`plan-${i}`, 'app-b', 'delivered', 1, 'initial'),
    );
    mocks.listPlansByApp.mockResolvedValue(plans);

    const BASE_TIME = new Date('2026-04-01T00:00:00.000Z').getTime();
    mocks.sliceForPlan.mockImplementation(async () => makeSlices(BASE_TIME, 30_000));
    mocks.aggregateByCategory.mockImplementation(() => makeAgg(10_000));

    const { handler } = await import('../timing-aggregator');
    await handler();

    expect(mocks.upsertCohort).not.toHaveBeenCalled();
  });

  it('correctly groups two cohorts (different kind) and writes both when both qualify', async () => {
    const app = makeApp('app-c', 'nextjs');
    mocks.listApps.mockResolvedValue([app]);

    // 5 plans kind=initial + 5 plans kind=change, same epicCount=2
    const initialPlans = Array.from({ length: 5 }, (_, i) =>
      makePlan(`initial-${i}`, 'app-c', 'delivered', 2, 'initial'),
    );
    const changePlans = Array.from({ length: 5 }, (_, i) =>
      makePlan(`change-${i}`, 'app-c', 'delivered', 2, 'change'),
    );
    mocks.listPlansByApp.mockResolvedValue([...initialPlans, ...changePlans]);

    const BASE_TIME = new Date('2026-04-01T00:00:00.000Z').getTime();
    mocks.sliceForPlan.mockImplementation(async () => makeSlices(BASE_TIME, 45_000));
    mocks.aggregateByCategory.mockImplementation(() => makeAgg(15_000));

    const { handler } = await import('../timing-aggregator');
    await handler();

    expect(mocks.upsertCohort).toHaveBeenCalledTimes(2);
    const keys = (mocks.upsertCohort.mock.calls as unknown[][]).map(
      (c) => (c[0] as { cohortKey: string }).cohortKey,
    );
    expect(keys).toContain('nextjs#initial#3');
    expect(keys).toContain('nextjs#change#3');
  });

  it('skips non-delivered plans', async () => {
    const app = makeApp('app-d', 'nextjs');
    mocks.listApps.mockResolvedValue([app]);

    // 6 plans but only 2 are delivered — rest are in concept/developing
    const plans = [
      ...Array.from({ length: 2 }, (_, i) =>
        makePlan(`del-${i}`, 'app-d', 'delivered', 2, 'initial'),
      ),
      ...Array.from({ length: 4 }, (_, i) =>
        makePlan(`dev-${i}`, 'app-d', 'developing', 2, 'initial'),
      ),
    ];
    mocks.listPlansByApp.mockResolvedValue(plans);

    const BASE_TIME = new Date('2026-04-01T00:00:00.000Z').getTime();
    mocks.sliceForPlan.mockImplementation(async () => makeSlices(BASE_TIME, 60_000));
    mocks.aggregateByCategory.mockImplementation(() => makeAgg(20_000));

    const { handler } = await import('../timing-aggregator');
    await handler();

    // Only 2 delivered plans — skipped (< 5)
    expect(mocks.upsertCohort).not.toHaveBeenCalled();
  });
});
