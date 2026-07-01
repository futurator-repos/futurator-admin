// Tests for escalator.ts (Story 1.8.7)
//
// All tests mock:
//   - getPlanById
//   - getApp (app-repository)
//   - getCohortByKey (timing-summary-repository)
//   - sliceForPlan (slicer)
//   - aggregateByCategory (aggregator)
//   - createAttentionItem (attention-items-repository)
//
// Test rows:
//   1. cohort missing → no items
//   2. cohort N=4 → no items (below minSamples=5)
//   3. review 4× cohort → 1 info item with correct metadata
//   4. review 6× cohort → 1 medium item
//   5. dev 5.5× + review 3.5× → 2 items (one medium, one info)
//   6. default hint applied to obscure category ('git')

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Plan, PlanKind } from '../../types/plan';
import type { App } from '../../types/app';
import type { TimerSlice } from '../types';
import type { AggregationResult } from '../aggregator';
import type { TimingSummary } from '../../repositories/timing-summary-repository';
import type { AttentionItem } from '../../types/attention';

// ── Mocks ─────────────────────────────────────────────────────────────────────

const mocks = vi.hoisted(() => ({
  getPlanById: vi.fn(),
  getApp: vi.fn(),
  getCohortByKey: vi.fn(),
  sliceForPlan: vi.fn(),
  aggregateByCategory: vi.fn(),
  createAttentionItem: vi.fn(),
  log: vi.fn(),
}));

vi.mock('../../repositories/plan-repository', () => ({
  getPlanById: mocks.getPlanById,
}));
vi.mock('../../repositories/app-repository', () => ({
  getApp: mocks.getApp,
}));
vi.mock('../../repositories/timing-summary-repository', () => ({
  getCohortByKey: mocks.getCohortByKey,
}));
vi.mock('../slicer', () => ({
  sliceForPlan: mocks.sliceForPlan,
}));
vi.mock('../aggregator', () => ({
  aggregateByCategory: mocks.aggregateByCategory,
}));
vi.mock('../../repositories/attention-items-repository', () => ({
  createAttentionItem: mocks.createAttentionItem,
}));
vi.mock('../../logger', () => ({
  log: mocks.log,
}));

// ── Helpers ───────────────────────────────────────────────────────────────────

function makePlan(
  planId: string = 'plan-1',
  appId: string = 'app-1',
  epicCount: number = 2,
  kind: PlanKind = 'initial',
): Plan & { appId: string; kind: PlanKind } {
  return {
    planId,
    name: 'test-plan',
    intent: 'test',
    description: '',
    status: 'delivered',
    epicIds: Array.from({ length: epicCount }, (_, i) => `epic-${i}`),
    workingDir: '/home/ubuntu/projects/test-plan',
    executionMode: 'pipeline',
    totalCostUsd: 0,
    totalStories: 0,
    doneStories: 0,
    createdAt: '2026-04-01T00:00:00.000Z',
    updatedAt: '2026-04-01T01:00:00.000Z',
    createdBy: 'test',
    appId,
    kind,
  };
}

function makeApp(appId: string = 'app-1', boilerplateType: string = 'nextjs'): App {
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

function makeCohort(
  samples: number,
  reviewMedianMs: number = 10_000,
  devMedianMs: number = 20_000,
  gitMedianMs?: number,
): TimingSummary {
  const zero = { medianMs: 0, p90Ms: 0, count: 0 };
  return {
    cohortKey: 'nextjs#initial#3',
    lastUpdated: '2026-04-28T06:00:00.000Z',
    samples,
    medianMs: 60_000,
    p90Ms: 90_000,
    byCategory: {
      dev: { medianMs: devMedianMs, p90Ms: devMedianMs * 1.5, count: 5 },
      'test-author': zero,
      'test-execute': zero,
      review: { medianMs: reviewMedianMs, p90Ms: reviewMedianMs * 1.5, count: 5 },
      qa: zero,
      po: zero,
      architect: zero,
      'baseline-check': zero,
      'tamper-check': zero,
      compile: zero,
      'merge-gate': zero,
      'vqa-gate': zero,
      'human-wait': zero,
      'machine-wait': zero,
      git: gitMedianMs ? { medianMs: gitMedianMs, p90Ms: gitMedianMs * 1.5, count: 3 } : zero,
      bootstrap: zero,
      fix: zero,
      idle: zero,
      unattributed: zero,
    },
    lastSampleIds: [],
  };
}

function makeAgg(reviewMs: number, devMs: number = 0, gitMs: number = 0): AggregationResult {
  const zero = { totalMs: 0, count: 0 };
  const totalMs = reviewMs + devMs + gitMs;
  return {
    byCategory: {
      dev: devMs > 0 ? { totalMs: devMs, count: 2 } : zero,
      'test-author': zero,
      'test-execute': zero,
      review: reviewMs > 0 ? { totalMs: reviewMs, count: 3 } : zero,
      qa: zero,
      po: zero,
      architect: zero,
      'baseline-check': zero,
      'tamper-check': zero,
      compile: zero,
      'merge-gate': zero,
      'vqa-gate': zero,
      'human-wait': zero,
      'machine-wait': zero,
      git: gitMs > 0 ? { totalMs: gitMs, count: 1 } : zero,
      bootstrap: zero,
      fix: zero,
      idle: zero,
      unattributed: zero,
    },
    totalMs,
  };
}

function makeSlices(): TimerSlice[] {
  return [
    {
      jobId: 'j1',
      eventSeq: '0001',
      category: 'review',
      startedAt: '2026-04-01T00:00:00.000Z',
      endedAt: '2026-04-01T01:00:00.000Z',
      durationMs: 3_600_000,
      agentRole: 'reviewer',
      eventType: 'text_delta',
    },
  ];
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('evaluateThresholds', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.createAttentionItem.mockResolvedValue(undefined);
    mocks.sliceForPlan.mockResolvedValue(makeSlices());
  });

  it('returns 0 items when cohort is missing', async () => {
    mocks.getPlanById.mockResolvedValue(makePlan());
    mocks.getApp.mockResolvedValue(makeApp());
    mocks.getCohortByKey.mockResolvedValue(null);
    mocks.aggregateByCategory.mockReturnValue(makeAgg(40_000));

    const { evaluateThresholds } = await import('../escalator');
    const result = await evaluateThresholds('plan-1');

    expect(result.itemsWritten).toBe(0);
    expect(mocks.createAttentionItem).not.toHaveBeenCalled();
  });

  it('returns 0 items when cohort has fewer than 5 samples', async () => {
    mocks.getPlanById.mockResolvedValue(makePlan());
    mocks.getApp.mockResolvedValue(makeApp());
    mocks.getCohortByKey.mockResolvedValue(makeCohort(4)); // below minSamples=5
    mocks.aggregateByCategory.mockReturnValue(makeAgg(40_000));

    const { evaluateThresholds } = await import('../escalator');
    const result = await evaluateThresholds('plan-1');

    expect(result.itemsWritten).toBe(0);
    expect(mocks.createAttentionItem).not.toHaveBeenCalled();
  });

  it('writes 1 info item when review is 4× cohort median', async () => {
    // cohort review median = 10_000ms; plan review = 40_000ms → ratio = 4.0 ≥ 3.0 (info)
    mocks.getPlanById.mockResolvedValue(makePlan());
    mocks.getApp.mockResolvedValue(makeApp());
    mocks.getCohortByKey.mockResolvedValue(makeCohort(6, 10_000));
    mocks.aggregateByCategory.mockReturnValue(makeAgg(40_000));

    const { evaluateThresholds } = await import('../escalator');
    const result = await evaluateThresholds('plan-1');

    expect(result.itemsWritten).toBe(1);
    expect(mocks.createAttentionItem).toHaveBeenCalledTimes(1);

    const item = mocks.createAttentionItem.mock.calls[0][0] as AttentionItem;
    // AC says 'info' severity; AttentionSeverity maps this to 'low'
    expect(item.severity).toBe('low');
    expect(item.category).toBe('pv2-timer-cohort-outlier');
    expect(item.title).toContain('review');
    expect(item.title).toContain('4.0×');
    expect(item.planId).toBe('plan-1');
    // Check metadata carries the ratio
    const anyItem = item as unknown as Record<string, unknown>;
    const meta = anyItem['metadata'] as { ratio: number; cat: string; samples: number };
    expect(meta.cat).toBe('review');
    expect(meta.ratio).toBeCloseTo(4.0);
    expect(meta.samples).toBe(6);
  });

  it('writes 1 medium item when review is 6× cohort median', async () => {
    // cohort review median = 10_000ms; plan review = 60_000ms → ratio = 6.0 ≥ 5.0 (medium)
    mocks.getPlanById.mockResolvedValue(makePlan());
    mocks.getApp.mockResolvedValue(makeApp());
    mocks.getCohortByKey.mockResolvedValue(makeCohort(7, 10_000));
    mocks.aggregateByCategory.mockReturnValue(makeAgg(60_000));

    const { evaluateThresholds } = await import('../escalator');
    const result = await evaluateThresholds('plan-1');

    expect(result.itemsWritten).toBe(1);
    const item = mocks.createAttentionItem.mock.calls[0][0] as AttentionItem;
    expect(item.severity).toBe('medium');
    expect(item.title).toContain('6.0×');
  });

  it('writes 2 items when dev is 5.5× (medium) and review is 3.5× (info)', async () => {
    // cohort review median = 10_000ms; plan review = 35_000ms → ratio 3.5 → info
    // cohort dev median = 20_000ms; plan dev = 110_000ms → ratio 5.5 → medium
    mocks.getPlanById.mockResolvedValue(makePlan());
    mocks.getApp.mockResolvedValue(makeApp());
    mocks.getCohortByKey.mockResolvedValue(makeCohort(8, 10_000, 20_000));
    mocks.aggregateByCategory.mockReturnValue(makeAgg(35_000, 110_000));

    const { evaluateThresholds } = await import('../escalator');
    const result = await evaluateThresholds('plan-1');

    expect(result.itemsWritten).toBe(2);
    const severities = (mocks.createAttentionItem.mock.calls as unknown[][]).map(
      (c) => (c[0] as AttentionItem).severity,
    );
    expect(severities).toContain('medium');
    // 'info' AC language maps to 'low' AttentionSeverity
    expect(severities).toContain('low');
  });

  it('applies default hint for obscure category (git)', async () => {
    // git 4× → info; no built-in hint → default hint used
    mocks.getPlanById.mockResolvedValue(makePlan());
    mocks.getApp.mockResolvedValue(makeApp());
    mocks.getCohortByKey.mockResolvedValue(makeCohort(6, 0, 0, 5_000)); // git median=5_000
    mocks.aggregateByCategory.mockReturnValue(makeAgg(0, 0, 20_000)); // git plan=20_000 → 4×

    const { evaluateThresholds } = await import('../escalator');
    const result = await evaluateThresholds('plan-1');

    expect(result.itemsWritten).toBe(1);
    const item = mocks.createAttentionItem.mock.calls[0][0] as AttentionItem;
    expect(item.body).toContain('cohort baseline');
  });

  it('returns 0 items when plan is not found', async () => {
    mocks.getPlanById.mockResolvedValue(null);

    const { evaluateThresholds } = await import('../escalator');
    const result = await evaluateThresholds('nonexistent');

    expect(result.itemsWritten).toBe(0);
    expect(mocks.createAttentionItem).not.toHaveBeenCalled();
  });
});
