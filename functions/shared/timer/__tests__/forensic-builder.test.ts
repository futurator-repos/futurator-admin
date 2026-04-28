// Tests for forensic-builder.ts (Story 1.8.3)
//
// Covers buildNarrative with:
//   - 0-slice / degenerate plan (totalMs = 0)
//   - normal plan with multiple categories
//   - plan with cohort outlier (largest cat > 2× cohort median)
//   - plan with cohort in-range
//   - plan with null cohort (insufficient samples)

import { describe, it, expect } from 'vitest';
import { buildNarrative } from '../forensic-builder';
import type { AggregationResult } from '../aggregator';
import type { CohortBaseline } from '../forensic-builder';
import type { Plan } from '../../types/plan';
import type { TimerSlice } from '../types';

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeAggregate(
  overrides: Partial<AggregationResult['byCategory']> & { _totalMs?: number },
): AggregationResult {
  const { _totalMs, ...cats } = overrides;
  const zero = { totalMs: 0, count: 0 };
  const byCategory: AggregationResult['byCategory'] = {
    dev: zero,
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
    ...cats,
  };
  const totalMs = _totalMs ?? Object.values(byCategory).reduce((s, v) => s + v.totalMs, 0);
  return { byCategory, totalMs };
}

const STUB_PLAN = {
  planId: 'plan-test-1',
  name: 'test-plan',
  intent: 'build something',
  description: '',
  status: 'delivered',
  epicIds: [],
  workingDir: '/home/ubuntu/projects/test-plan',
  executionMode: 'orchestrator',
  totalCostUsd: 0,
  totalStories: 0,
  doneStories: 0,
  createdAt: '2026-04-01T00:00:00.000Z',
  updatedAt: '2026-04-01T01:00:00.000Z',
  createdBy: 'test',
} as Plan;

const EMPTY_SLICES: TimerSlice[] = [];

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('buildNarrative', () => {
  // 1. Degenerate — 0 slices, totalMs = 0
  it('handles 0-slice / empty aggregate gracefully (no throw)', () => {
    const agg = makeAggregate({});
    const narrative = buildNarrative(STUB_PLAN, EMPTY_SLICES, agg, null);
    expect(typeof narrative).toBe('string');
    expect(narrative.length).toBeGreaterThan(0);
    expect(narrative).toContain('0s');
  });

  // 2. Degenerate produces 5 sentences (ends with period)
  it('degenerate aggregate: narrative ends with a period', () => {
    const agg = makeAggregate({});
    const narrative = buildNarrative(STUB_PLAN, EMPTY_SLICES, agg, null);
    expect(narrative.trimEnd()).toMatch(/\.$/);
  });

  // 3. Normal plan — largest category is dev
  it('identifies dev as largest category when dev time dominates', () => {
    const agg = makeAggregate({
      dev: { totalMs: 480_000, count: 10 }, // 8 min — 75%
      review: { totalMs: 120_000, count: 3 }, // 2 min
      compile: { totalMs: 40_000, count: 5 }, // 40s
    });
    const narrative = buildNarrative(STUB_PLAN, EMPTY_SLICES, agg, null);
    expect(narrative).toContain('Largest category: dev');
    expect(narrative).toContain('8m 0s');
  });

  // 4. Normal plan — smallest meaningful category mentioned in sentence 3
  it('mentions smallest meaningful nonzero category in sentence 3', () => {
    const agg = makeAggregate({
      dev: { totalMs: 480_000, count: 10 },
      review: { totalMs: 120_000, count: 3 },
      compile: { totalMs: 5_000, count: 1 }, // smallest nonzero
    });
    const narrative = buildNarrative(STUB_PLAN, EMPTY_SLICES, agg, null);
    expect(narrative).toContain('compile');
    expect(narrative).toContain('Smallest meaningful category');
  });

  // 5. Cohort outlier — review at > 2× cohort median triggers specific hint
  it('flags review outlier when review > 2x cohort median', () => {
    const agg = makeAggregate({
      dev: { totalMs: 300_000, count: 8 },
      review: { totalMs: 600_000, count: 5 }, // very high review time
    });
    const cohort: CohortBaseline = {
      samples: 7,
      medianMs: 400_000,
      p90Ms: 600_000,
      byCategory: {
        dev: { medianMs: 200_000, p90Ms: 320_000 },
        review: { medianMs: 120_000, p90Ms: 200_000 }, // review median 2 min — this plan 10 min = 5×
        'test-author': { medianMs: 0, p90Ms: 0 },
        'test-execute': { medianMs: 0, p90Ms: 0 },
        qa: { medianMs: 0, p90Ms: 0 },
        po: { medianMs: 0, p90Ms: 0 },
        architect: { medianMs: 0, p90Ms: 0 },
        compile: { medianMs: 20_000, p90Ms: 40_000 },
        'human-wait': { medianMs: 0, p90Ms: 0 },
        'machine-wait': { medianMs: 0, p90Ms: 0 },
        git: { medianMs: 0, p90Ms: 0 },
        bootstrap: { medianMs: 0, p90Ms: 0 },
        fix: { medianMs: 0, p90Ms: 0 },
        idle: { medianMs: 0, p90Ms: 0 },
        unattributed: { medianMs: 0, p90Ms: 0 },
      },
    };
    const narrative = buildNarrative(STUB_PLAN, EMPTY_SLICES, agg, cohort);
    // Sentence 4 should call out the outlier
    expect(narrative).toContain('Outlier vs cohort: review');
    // Sentence 5 should give the review-looping hint
    expect(narrative).toContain('Review may be looping');
  });

  // 6. Cohort in-range — all categories within 2× → no outlier hint
  it('gives "within expected cohort ranges" hint when no outlier', () => {
    const agg = makeAggregate({
      dev: { totalMs: 300_000, count: 8 },
      review: { totalMs: 100_000, count: 3 },
    });
    const cohort: CohortBaseline = {
      samples: 6,
      medianMs: 350_000,
      p90Ms: 500_000,
      byCategory: {
        dev: { medianMs: 280_000, p90Ms: 400_000 }, // ratio ≈ 1.07 — in range
        review: { medianMs: 90_000, p90Ms: 150_000 }, // ratio ≈ 1.11 — in range
        'test-author': { medianMs: 0, p90Ms: 0 },
        'test-execute': { medianMs: 0, p90Ms: 0 },
        qa: { medianMs: 0, p90Ms: 0 },
        po: { medianMs: 0, p90Ms: 0 },
        architect: { medianMs: 0, p90Ms: 0 },
        compile: { medianMs: 0, p90Ms: 0 },
        'human-wait': { medianMs: 0, p90Ms: 0 },
        'machine-wait': { medianMs: 0, p90Ms: 0 },
        git: { medianMs: 0, p90Ms: 0 },
        bootstrap: { medianMs: 0, p90Ms: 0 },
        fix: { medianMs: 0, p90Ms: 0 },
        idle: { medianMs: 0, p90Ms: 0 },
        unattributed: { medianMs: 0, p90Ms: 0 },
      },
    };
    const narrative = buildNarrative(STUB_PLAN, EMPTY_SLICES, agg, cohort);
    expect(narrative).toContain('within expected cohort ranges');
  });

  // 7. No cohort → sentence 4 says "No cohort baseline yet"
  it('says "No cohort baseline yet" when cohort is null', () => {
    const agg = makeAggregate({
      dev: { totalMs: 200_000, count: 5 },
    });
    const narrative = buildNarrative(STUB_PLAN, EMPTY_SLICES, agg, null);
    expect(narrative).toContain('No cohort baseline yet');
    expect(narrative).toContain('5+');
  });

  // 8. Total duration formatted correctly (minutes + seconds)
  it('formats total duration as Xm Ys', () => {
    const agg = makeAggregate({
      dev: { totalMs: 752_000, count: 10 }, // 12m 32s
    });
    const narrative = buildNarrative(STUB_PLAN, EMPTY_SLICES, agg, null);
    expect(narrative).toContain('12m 32s');
  });

  // 9. Duration under 1 minute formatted as just Ys
  it('formats sub-minute duration as Ys', () => {
    const agg = makeAggregate({
      dev: { totalMs: 45_000, count: 2 }, // 45s
    });
    const narrative = buildNarrative(STUB_PLAN, EMPTY_SLICES, agg, null);
    expect(narrative).toContain('45s');
  });

  // 10. fix category outlier hint
  it('gives remediation hint when fix is the largest outlier vs cohort', () => {
    const agg = makeAggregate({
      fix: { totalMs: 900_000, count: 15 }, // 15 min — very high
      dev: { totalMs: 200_000, count: 5 },
    });
    const cohort: CohortBaseline = {
      samples: 5,
      medianMs: 300_000,
      p90Ms: 600_000,
      byCategory: {
        fix: { medianMs: 50_000, p90Ms: 100_000 }, // fix at 18× cohort
        dev: { medianMs: 200_000, p90Ms: 350_000 },
        'test-author': { medianMs: 0, p90Ms: 0 },
        'test-execute': { medianMs: 0, p90Ms: 0 },
        qa: { medianMs: 0, p90Ms: 0 },
        po: { medianMs: 0, p90Ms: 0 },
        architect: { medianMs: 0, p90Ms: 0 },
        compile: { medianMs: 0, p90Ms: 0 },
        'human-wait': { medianMs: 0, p90Ms: 0 },
        'machine-wait': { medianMs: 0, p90Ms: 0 },
        git: { medianMs: 0, p90Ms: 0 },
        bootstrap: { medianMs: 0, p90Ms: 0 },
        idle: { medianMs: 0, p90Ms: 0 },
        unattributed: { medianMs: 0, p90Ms: 0 },
      },
    };
    const narrative = buildNarrative(STUB_PLAN, EMPTY_SLICES, agg, cohort);
    expect(narrative).toContain('Outlier vs cohort: fix');
    expect(narrative).toContain('Remediation time is elevated');
  });
});
