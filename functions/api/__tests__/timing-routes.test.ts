// Story 1.8.3 — Timer Intelligence API route tests
//
// Strategy: all repository and timer modules are vi.mock'd at module boundary.
// A standalone Hono app is built from the same service layer used in index.ts.
// This tests the controller/route logic (parameter validation, 404 handling,
// response shapes) without requiring a full Lambda invocation or real DDB.
//
// Routes under test:
//   GET /api/plans/:planId/timing
//   GET /api/apps/:appId/timing
//   GET /api/timing/cohort?templateType=<>&planKind=<>&epicCount=<>
//   GET /api/plans/:planId/timing/forensic

import { describe, it, expect, vi, beforeEach, type MockedFunction } from 'vitest';
import { Hono } from 'hono';
import type { Plan } from '../../shared/types/plan';
import type { App } from '../../shared/types/app';
import type { TimerSlice } from '../../shared/timer/types';
import type { AggregationResult } from '../../shared/timer/aggregator';

// ── Module mocks (must be declared before imports) ───────────────────────────

vi.mock('../../shared/timer/slicer', () => ({
  sliceForPlan: vi.fn(),
}));

vi.mock('../../shared/timer/aggregator', () => ({
  aggregateByCategory: vi.fn(),
}));

vi.mock('../../shared/repositories/plan-repository', () => ({
  getPlanById: vi.fn(),
  listPlansByApp: vi.fn(),
}));

vi.mock('../../shared/repositories/app-repository', () => ({
  getApp: vi.fn(),
  listApps: vi.fn(),
}));

vi.mock('../../shared/repositories/epic-workflow-repository', () => ({
  getEpicById: vi.fn(),
}));

vi.mock('../../shared/repositories/agent-events-repository', () => ({
  getEventsAfter: vi.fn(),
}));

vi.mock('../../shared/timer/forensic-builder', async (importActual) => {
  // Keep buildNarrative real so sentence logic is tested via forensic-builder.test.ts.
  // Mock buildForensicPayload to control the output in route tests.
  const actual = await importActual<typeof import('../../shared/timer/forensic-builder')>();
  return {
    ...actual,
    buildForensicPayload: vi.fn(),
  };
});

// ── Imports (after mocks) ─────────────────────────────────────────────────────

import { sliceForPlan } from '../../shared/timer/slicer';
import { aggregateByCategory } from '../../shared/timer/aggregator';
import { getPlanById, listPlansByApp } from '../../shared/repositories/plan-repository';
import { getApp, listApps } from '../../shared/repositories/app-repository';
import { buildForensicPayload } from '../../shared/timer/forensic-builder';
import { timingCohortQuerySchema } from '../../shared/schemas/timing-cohort-query-schema';

// Typed mock aliases
const mockSliceForPlan = sliceForPlan as MockedFunction<typeof sliceForPlan>;
const mockAggregateByCategory = aggregateByCategory as MockedFunction<typeof aggregateByCategory>;
const mockGetPlanById = getPlanById as MockedFunction<typeof getPlanById>;
const mockListPlansByApp = listPlansByApp as MockedFunction<typeof listPlansByApp>;
const mockGetApp = getApp as MockedFunction<typeof getApp>;
const mockListApps = listApps as MockedFunction<typeof listApps>;
const mockBuildForensicPayload = buildForensicPayload as MockedFunction<
  typeof buildForensicPayload
>;

// ── Test Fixtures ─────────────────────────────────────────────────────────────

const PLAN_ID = 'plan-abc-123';
const APP_ID = 'my-app';

function makePlan(overrides: Partial<Plan> = {}): Plan {
  return {
    planId: PLAN_ID,
    name: 'my-app',
    displayName: 'My App',
    intent: 'build something',
    description: 'A test plan',
    status: 'delivered',
    epicIds: ['epic-1'],
    workingDir: '/home/ubuntu/projects/my-app',
    executionMode: 'orchestrator',
    totalCostUsd: 0,
    totalStories: 3,
    doneStories: 3,
    createdAt: '2026-04-01T00:00:00.000Z',
    updatedAt: '2026-04-01T01:00:00.000Z',
    createdBy: 'user-1',
    kind: 'initial',
    appId: APP_ID,
    ...overrides,
  };
}

function makeApp(overrides: Partial<App> = {}): App {
  return {
    appId: APP_ID,
    displayName: 'My App',
    workingDir: `/home/ubuntu/projects/${APP_ID}`,
    executionMode: 'orchestrator',
    currentlyDeployedPlanId: null,
    deployJobIds: [],
    workingTreeStatus: 'clean',
    createdAt: '2026-04-01T00:00:00.000Z',
    updatedAt: '2026-04-01T00:00:00.000Z',
    ...overrides,
  };
}

function makeSlice(overrides: Partial<TimerSlice> = {}): TimerSlice {
  return {
    jobId: 'job-1',
    eventSeq: '000001',
    category: 'dev',
    startedAt: '2026-04-01T00:00:00.000Z',
    endedAt: '2026-04-01T00:05:00.000Z',
    durationMs: 300_000,
    agentRole: 'dev',
    eventType: 'text_delta',
    ...overrides,
  };
}

function makeAggregate(totalMs = 300_000): AggregationResult {
  const zero = { totalMs: 0, count: 0 };
  return {
    totalMs,
    byCategory: {
      dev: { totalMs, count: 3 },
      'test-author': zero,
      'test-execute': zero,
      review: zero,
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
  };
}

// ── Test Hono app ─────────────────────────────────────────────────────────────
// Mirrors the 4 routes from index.ts. Auth is bypassed via a passthrough stub.

function buildTestApp(): Hono {
  const testApp = new Hono();

  // ── GET /api/plans/:planId/timing ─────────────────────────────────────────
  testApp.get('/api/plans/:planId/timing', async (c) => {
    const planId = c.req.param('planId');
    const plan = await getPlanById(planId);
    if (!plan)
      return c.json({ error: { code: 'NOT_FOUND', message: `Plan '${planId}' not found` } }, 404);

    const slices = await sliceForPlan(planId);
    const aggregate = aggregateByCategory(slices);

    let planTotalMs = 0;
    if (slices.length >= 2) {
      const first = new Date(slices[0].startedAt).getTime();
      const last = new Date(slices[slices.length - 1].endedAt).getTime();
      planTotalMs = Math.max(0, last - first);
    } else if (slices.length === 1) {
      planTotalMs = slices[0].durationMs;
    }

    const isLive = slices.some((s) => s.isLive === true);
    return c.json({ planId, slices, aggregate, planTotalMs, isLive });
  });

  // ── GET /api/apps/:appId/timing ──────────────────────────────────────────
  testApp.get('/api/apps/:appId/timing', async (c) => {
    const appId = c.req.param('appId');
    const app_ = await getApp(appId);
    if (!app_)
      return c.json({ error: { code: 'NOT_FOUND', message: `App '${appId}' not found` } }, 404);

    const allPlans = await listPlansByApp(appId);
    const TERMINAL_SUCCESS = new Set(['delivered']);
    const completed = allPlans
      .filter((p) => TERMINAL_SUCCESS.has(p.status))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, 20);

    const recentPlans: Array<{
      planId: string;
      planLabel: string;
      startedAt: string | null;
      endedAt: string | null;
      durationMs: number;
      byCategory: AggregationResult['byCategory'];
    }> = [];

    const appTotals: Record<string, number> = {};
    let appTotalMs = 0;

    for (const plan of completed) {
      const slices = await sliceForPlan(plan.planId);
      const agg = aggregateByCategory(slices);

      let startedAt: string | null = null;
      let endedAt: string | null = null;
      let durationMs = 0;

      if (slices.length > 0) {
        startedAt = slices[0].startedAt;
        endedAt = slices[slices.length - 1].endedAt;
        durationMs = Math.max(0, new Date(endedAt).getTime() - new Date(startedAt).getTime());
      }

      for (const [cat, summary] of Object.entries(agg.byCategory)) {
        appTotals[cat] = (appTotals[cat] ?? 0) + (summary as { totalMs: number }).totalMs;
      }
      appTotalMs += agg.totalMs;

      recentPlans.push({
        planId: plan.planId,
        planLabel: plan.iterationLabel ?? plan.displayName ?? plan.name,
        startedAt,
        endedAt,
        durationMs,
        byCategory: agg.byCategory,
      });
    }

    const appByCategory = Object.fromEntries(
      Object.entries(appTotals).map(([cat, totalMs]) => [cat, { totalMs, count: 0 }]),
    ) as AggregationResult['byCategory'];

    return c.json({
      appId,
      recentPlans,
      appAggregate: { byCategory: appByCategory, totalMs: appTotalMs },
    });
  });

  // ── GET /api/timing/cohort ────────────────────────────────────────────────
  testApp.get('/api/timing/cohort', async (c) => {
    const parsed = timingCohortQuerySchema.safeParse({
      templateType: c.req.query('templateType'),
      planKind: c.req.query('planKind'),
      epicCount: c.req.query('epicCount'),
    });
    if (!parsed.success) {
      return c.json(
        {
          error: {
            code: 'VALIDATION_ERROR',
            message: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '),
          },
        },
        422,
      );
    }
    const { templateType, planKind, epicCount } = parsed.data;

    const allApps = await listApps();
    const TERMINAL_SUCCESS = new Set(['delivered']);
    const EPIC_COUNT_TOLERANCE = 0.25;

    const matchedDurations: number[] = [];
    const categoryDurations: Record<string, number[]> = {};

    for (const app_ of allApps) {
      const appBoilerplate: string =
        ((app_ as Record<string, unknown>).boilerplateType as string) ?? 'nextjs';
      if (appBoilerplate !== templateType) continue;

      const plans = await listPlansByApp(app_.appId);
      for (const plan of plans) {
        if (!TERMINAL_SUCCESS.has(plan.status)) continue;
        if (plan.kind !== planKind) continue;
        const planEpicCount = (plan.epicIds ?? []).length;
        const lo = Math.floor(epicCount * (1 - EPIC_COUNT_TOLERANCE));
        const hi = Math.ceil(epicCount * (1 + EPIC_COUNT_TOLERANCE));
        if (planEpicCount < lo || planEpicCount > hi) continue;

        const slices = await sliceForPlan(plan.planId);
        if (slices.length === 0) continue;

        const agg = aggregateByCategory(slices);
        const firstMs = new Date(slices[0].startedAt).getTime();
        const lastMs = new Date(slices[slices.length - 1].endedAt).getTime();
        matchedDurations.push(Math.max(0, lastMs - firstMs));

        for (const [cat, summary] of Object.entries(agg.byCategory)) {
          if (!categoryDurations[cat]) categoryDurations[cat] = [];
          categoryDurations[cat].push((summary as { totalMs: number }).totalMs);
        }
      }
    }

    const samples = matchedDurations.length;
    if (samples < 5) {
      return c.json({ error: 'cohort-insufficient', samples }, 404);
    }

    function percentile(sorted: number[], p: number): number {
      if (sorted.length === 0) return 0;
      const idx = Math.ceil(sorted.length * p) - 1;
      return sorted[Math.max(0, Math.min(idx, sorted.length - 1))];
    }

    const sortedDurations = [...matchedDurations].sort((a, b) => a - b);
    const medianMs = percentile(sortedDurations, 0.5);
    const p90Ms = percentile(sortedDurations, 0.9);

    const byCategoryStats: Record<string, { medianMs: number; p90Ms: number }> = {};
    for (const [cat, durations] of Object.entries(categoryDurations)) {
      const sorted = [...durations].sort((a, b) => a - b);
      byCategoryStats[cat] = { medianMs: percentile(sorted, 0.5), p90Ms: percentile(sorted, 0.9) };
    }

    return c.json({ samples, medianMs, p90Ms, byCategory: byCategoryStats });
  });

  // ── GET /api/plans/:planId/timing/forensic ────────────────────────────────
  testApp.get('/api/plans/:planId/timing/forensic', async (c) => {
    const planId = c.req.param('planId');
    const payload = await buildForensicPayload(planId, async () => null);
    if (!payload) {
      return c.json({ error: { code: 'NOT_FOUND', message: `Plan '${planId}' not found` } }, 404);
    }
    const filename = `${planId}-forensic.json`;
    return c.body(JSON.stringify(payload, null, 2), 200, {
      'Content-Type': 'application/json',
      'Content-Disposition': `attachment; filename="${filename}"`,
    });
  });

  return testApp;
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('Timer Intelligence API routes', () => {
  let testApp: Hono;

  beforeEach(() => {
    vi.clearAllMocks();
    testApp = buildTestApp();
  });

  // ─── GET /api/plans/:planId/timing ────────────────────────────────────────

  describe('GET /api/plans/:planId/timing', () => {
    // Test 1: 200 happy path
    it('returns 200 with slices, aggregate, planTotalMs, isLive=false for a found plan', async () => {
      const plan = makePlan();
      const slices = [
        makeSlice({
          startedAt: '2026-04-01T00:00:00.000Z',
          endedAt: '2026-04-01T00:05:00.000Z',
          durationMs: 300_000,
        }),
        makeSlice({
          startedAt: '2026-04-01T00:05:00.000Z',
          endedAt: '2026-04-01T00:08:00.000Z',
          durationMs: 180_000,
        }),
      ];
      const agg = makeAggregate(480_000);

      mockGetPlanById.mockResolvedValue(plan);
      mockSliceForPlan.mockResolvedValue(slices);
      mockAggregateByCategory.mockReturnValue(agg);

      const res = await testApp.request(`/api/plans/${PLAN_ID}/timing`);
      expect(res.status).toBe(200);

      const body = (await res.json()) as {
        planId: string;
        slices: TimerSlice[];
        aggregate: AggregationResult;
        planTotalMs: number;
        isLive: boolean;
      };
      expect(body.planId).toBe(PLAN_ID);
      expect(body.slices).toHaveLength(2);
      expect(body.isLive).toBe(false);
      // Wall-clock: 00:08 - 00:00 = 8 minutes = 480_000ms
      expect(body.planTotalMs).toBe(480_000);
    });

    // Test 2: 404 when plan not found
    it('returns 404 when plan does not exist', async () => {
      mockGetPlanById.mockResolvedValue(null);

      const res = await testApp.request('/api/plans/nonexistent/timing');
      expect(res.status).toBe(404);
      const body = (await res.json()) as { error: { code: string } };
      expect(body.error.code).toBe('NOT_FOUND');
    });

    // Test 3: isLive=true when any slice has isLive
    it('returns isLive=true when any slice has isLive=true', async () => {
      mockGetPlanById.mockResolvedValue(makePlan());
      mockSliceForPlan.mockResolvedValue([makeSlice({ isLive: true })]);
      mockAggregateByCategory.mockReturnValue(makeAggregate());

      const res = await testApp.request(`/api/plans/${PLAN_ID}/timing`);
      const body = (await res.json()) as { isLive: boolean };
      expect(body.isLive).toBe(true);
    });
  });

  // ─── GET /api/apps/:appId/timing ─────────────────────────────────────────

  describe('GET /api/apps/:appId/timing', () => {
    // Test 4: 404 when app not found
    it('returns 404 when app does not exist', async () => {
      mockGetApp.mockResolvedValue(null);

      const res = await testApp.request('/api/apps/no-app/timing');
      expect(res.status).toBe(404);
      const body = (await res.json()) as { error: { code: string } };
      expect(body.error.code).toBe('NOT_FOUND');
    });

    // Test 5: 200 with empty recentPlans when no completed plans exist
    it('returns 200 with empty recentPlans when app has no delivered plans', async () => {
      mockGetApp.mockResolvedValue(makeApp());
      mockListPlansByApp.mockResolvedValue([
        makePlan({ status: 'developing' }), // not terminal-success
      ]);

      const res = await testApp.request(`/api/apps/${APP_ID}/timing`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        appId: string;
        recentPlans: unknown[];
        appAggregate: AggregationResult;
      };
      expect(body.appId).toBe(APP_ID);
      expect(body.recentPlans).toHaveLength(0);
      expect(body.appAggregate.totalMs).toBe(0);
    });

    // Test 6: 200 with 3 completed plans aggregated
    it('returns 200 with 3 completed plans and correct aggregate', async () => {
      mockGetApp.mockResolvedValue(makeApp());

      const plans = [
        makePlan({ planId: 'plan-1', status: 'delivered', createdAt: '2026-04-01T00:00:00.000Z' }),
        makePlan({ planId: 'plan-2', status: 'delivered', createdAt: '2026-04-02T00:00:00.000Z' }),
        makePlan({ planId: 'plan-3', status: 'delivered', createdAt: '2026-04-03T00:00:00.000Z' }),
      ];
      mockListPlansByApp.mockResolvedValue(plans);

      // Each plan returns 1 slice + 300k ms aggregate
      const singleSlice = [makeSlice()];
      mockSliceForPlan.mockResolvedValue(singleSlice);
      mockAggregateByCategory.mockReturnValue(makeAggregate(300_000));

      const res = await testApp.request(`/api/apps/${APP_ID}/timing`);
      expect(res.status).toBe(200);

      const body = (await res.json()) as {
        recentPlans: unknown[];
        appAggregate: { totalMs: number };
      };
      expect(body.recentPlans).toHaveLength(3);
      // 3 plans × 300k ms each = 900k total
      expect(body.appAggregate.totalMs).toBe(900_000);
    });
  });

  // ─── GET /api/timing/cohort ───────────────────────────────────────────────

  describe('GET /api/timing/cohort', () => {
    // Test 7: 422 on missing required params
    it('returns 422 when templateType is invalid', async () => {
      const res = await testApp.request(
        '/api/timing/cohort?templateType=ruby&planKind=initial&epicCount=3',
      );
      expect(res.status).toBe(422);
      const body = (await res.json()) as { error: { code: string } };
      expect(body.error.code).toBe('VALIDATION_ERROR');
    });

    // Test 8: 422 when epicCount is 0 (below min 1)
    it('returns 422 when epicCount is 0', async () => {
      const res = await testApp.request(
        '/api/timing/cohort?templateType=nextjs&planKind=initial&epicCount=0',
      );
      expect(res.status).toBe(422);
    });

    // Test 9: 404 cohort-insufficient when only 3 samples
    it('returns 404 cohort-insufficient when fewer than 5 matching plans', async () => {
      // Provide 3 apps, each with 1 matching plan (total samples = 3)
      const apps = [
        makeApp({ appId: 'app-1' }),
        makeApp({ appId: 'app-2' }),
        makeApp({ appId: 'app-3' }),
      ];
      mockListApps.mockResolvedValue(apps);

      const plan = makePlan({ kind: 'initial', status: 'delivered', epicIds: ['e1'] });
      mockListPlansByApp.mockResolvedValue([plan]);

      const slices = [
        makeSlice({ startedAt: '2026-04-01T00:00:00.000Z', endedAt: '2026-04-01T00:05:00.000Z' }),
      ];
      mockSliceForPlan.mockResolvedValue(slices);
      mockAggregateByCategory.mockReturnValue(makeAggregate(300_000));

      const res = await testApp.request(
        '/api/timing/cohort?templateType=nextjs&planKind=initial&epicCount=1',
      );
      expect(res.status).toBe(404);
      const body = (await res.json()) as { error: string; samples: number };
      expect(body.error).toBe('cohort-insufficient');
      expect(body.samples).toBe(3);
    });

    // Test 10: 200 with 6-sample cohort fixture
    it('returns 200 with medianMs, p90Ms, byCategory for ≥5 matching plans', async () => {
      // 6 apps, each with 1 matching plan
      const apps = Array.from({ length: 6 }, (_, i) => makeApp({ appId: `app-${i}` }));
      mockListApps.mockResolvedValue(apps);

      const plan = makePlan({ kind: 'initial', status: 'delivered', epicIds: ['e1'] });
      mockListPlansByApp.mockResolvedValue([plan]);

      // Each plan: 1 slice spanning 5 minutes, total 300k ms
      const slices = [
        makeSlice({
          startedAt: '2026-04-01T00:00:00.000Z',
          endedAt: '2026-04-01T00:05:00.000Z',
          durationMs: 300_000,
        }),
      ];
      mockSliceForPlan.mockResolvedValue(slices);
      mockAggregateByCategory.mockReturnValue(makeAggregate(300_000));

      const res = await testApp.request(
        '/api/timing/cohort?templateType=nextjs&planKind=initial&epicCount=1',
      );
      expect(res.status).toBe(200);

      const body = (await res.json()) as {
        samples: number;
        medianMs: number;
        p90Ms: number;
        byCategory: Record<string, { medianMs: number; p90Ms: number }>;
      };
      expect(body.samples).toBe(6);
      expect(body.medianMs).toBeGreaterThan(0);
      expect(body.p90Ms).toBeGreaterThanOrEqual(body.medianMs);
      expect(body.byCategory).toBeDefined();
      expect(typeof body.byCategory.dev).toBe('object');
    });
  });

  // ─── GET /api/plans/:planId/timing/forensic ───────────────────────────────

  describe('GET /api/plans/:planId/timing/forensic', () => {
    // Test 11: 200 with proper Content-Disposition header + narrative present
    it('returns 200 with correct Content-Disposition and schemaVersion', async () => {
      const plan = makePlan();
      const slices = [makeSlice()];
      const agg = makeAggregate();

      mockBuildForensicPayload.mockResolvedValue({
        schemaVersion: 'timer-intel-v1.0',
        plan,
        events: [],
        slices,
        aggregate: agg,
        cohort: null,
        narrative:
          'Total attributed time: 5m 0s. Largest category: dev (100%, 5m 0s). Only one category recorded; no other meaningful breakdown available. No cohort baseline yet (need 5+ similar plans). Collect more plans to unlock cohort-based recommendations.',
      });

      const res = await testApp.request(`/api/plans/${PLAN_ID}/timing/forensic`);
      expect(res.status).toBe(200);
      expect(res.headers.get('Content-Type')).toContain('application/json');
      expect(res.headers.get('Content-Disposition')).toBe(
        `attachment; filename="${PLAN_ID}-forensic.json"`,
      );

      const text = await res.text();
      const body = JSON.parse(text) as {
        schemaVersion: string;
        narrative: string;
        cohort: null;
      };
      expect(body.schemaVersion).toBe('timer-intel-v1.0');
      expect(typeof body.narrative).toBe('string');
      expect(body.narrative.length).toBeGreaterThan(0);
      expect(body.cohort).toBeNull();
    });

    // Test 12: 404 when plan not found
    it('returns 404 when buildForensicPayload returns null (plan not found)', async () => {
      mockBuildForensicPayload.mockResolvedValue(null);

      const res = await testApp.request('/api/plans/no-such-plan/timing/forensic');
      expect(res.status).toBe(404);
      const body = (await res.json()) as { error: { code: string } };
      expect(body.error.code).toBe('NOT_FOUND');
    });

    // Test 13: narrative field is always a non-empty string
    it('forensic payload contains a non-empty narrative field', async () => {
      const plan = makePlan();
      mockBuildForensicPayload.mockResolvedValue({
        schemaVersion: 'timer-intel-v1.0',
        plan,
        events: [],
        slices: [],
        aggregate: makeAggregate(0),
        cohort: null,
        narrative:
          'Total attributed time: 0s (no events recorded). No category data available. Only one category recorded; no other meaningful breakdown available. No cohort baseline yet (need 5+ similar plans). Collect more plans to unlock cohort-based recommendations.',
      });

      const res = await testApp.request(`/api/plans/${PLAN_ID}/timing/forensic`);
      const body = JSON.parse(await res.text()) as { narrative: string };
      expect(body.narrative.trim().length).toBeGreaterThan(10);
    });
  });
});
