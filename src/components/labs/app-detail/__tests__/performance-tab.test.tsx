/**
 * Story 1.8.5 — PerformanceTab tests
 *
 * Mocks:
 *   - @/lib/api-client — prevents real network calls.
 *   - @/hooks/use-app-timing — returns synthetic plans.
 *   - @/hooks/use-cohort — returns controlled cohort data or COHORT_ACCUMULATING.
 *
 * Test rows:
 *   1. Empty state when no plans.
 *   2. Renders 3 plans with mini bars.
 *   3. Drift marker appears when synthetic data has ≥ 1-SD shift.
 *   4. Cohort 404 → "Cohort accumulating" pill.
 *   5. Sortable by duration ascending.
 *   6. Sortable by duration descending.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import type { AppTimingData, PlanTimingSummary } from '@/hooks/use-app-timing';
import { COHORT_ACCUMULATING } from '@/hooks/use-cohort';

// ── Mocks ──────────────────────────────────────────────────────────────────

vi.mock('@/lib/api-client', () => ({
  api: {
    fetch: vi.fn(),
    get: vi.fn(),
    post: vi.fn(),
    put: vi.fn(),
    patch: vi.fn(),
    delete: vi.fn(),
  },
}));

vi.mock('@/hooks/use-app-timing', () => ({
  useAppTiming: vi.fn(),
}));

vi.mock('@/hooks/use-cohort', async (importOriginal) => {
  const original = await importOriginal<typeof import('@/hooks/use-cohort')>();
  return {
    ...original,
    useCohort: vi.fn(),
  };
});

import { useAppTiming } from '@/hooks/use-app-timing';
import { useCohort } from '@/hooks/use-cohort';
import { PerformanceTab } from '../performance-tab';

// ── Fixtures ───────────────────────────────────────────────────────────────

const APP_ID = 'app-test-001';
const APP = { boilerplateType: 'nextjs' as const };

function makePlan(
  overrides: Partial<PlanTimingSummary> & { startedAt: string },
): PlanTimingSummary {
  return {
    planId: `plan-${overrides.startedAt.replace(/\D/g, '')}`,
    planLabel: 'v1',
    endedAt: overrides.startedAt,
    durationMs: 600_000,
    byCategory: {
      dev: 300_000,
      review: 150_000,
      compile: 150_000,
    },
    ...overrides,
  };
}

function makeTimingData(plans: PlanTimingSummary[]): AppTimingData {
  return {
    appId: APP_ID,
    recentPlans: plans,
    appAggregate: { byCategory: {}, totalMs: 0 },
  };
}

// Default cohort: no drift, normal ratio
const DEFAULT_COHORT = {
  samples: 10,
  medianMs: 600_000,
  p90Ms: 900_000,
  byCategory: {},
};

// ── Tests ──────────────────────────────────────────────────────────────────

describe('PerformanceTab', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(useCohort).mockReturnValue({
      data: DEFAULT_COHORT,
      isLoading: false,
      error: null,
    } as ReturnType<typeof useCohort>);
  });

  it('shows empty state when no plans', () => {
    vi.mocked(useAppTiming).mockReturnValue({
      data: makeTimingData([]),
      isLoading: false,
      error: null,
    } as ReturnType<typeof useAppTiming>);

    render(<PerformanceTab appId={APP_ID} app={APP} />);

    expect(screen.getByTestId('performance-empty-state')).toBeInTheDocument();
    expect(screen.getByText(/run a plan to see performance data/i)).toBeInTheDocument();
  });

  it('renders 3 plans with mini bars', () => {
    const plans = [
      makePlan({ startedAt: '2026-04-26T10:00:00Z', durationMs: 600_000 }),
      makePlan({ startedAt: '2026-04-27T10:00:00Z', durationMs: 720_000 }),
      makePlan({ startedAt: '2026-04-28T10:00:00Z', durationMs: 540_000 }),
    ];

    vi.mocked(useAppTiming).mockReturnValue({
      data: makeTimingData(plans),
      isLoading: false,
      error: null,
    } as ReturnType<typeof useAppTiming>);

    render(<PerformanceTab appId={APP_ID} app={APP} />);

    // Each plan row has a mini bar with role="img"
    const bars = screen.getAllByRole('img');
    // At least 3 bars (one per plan)
    expect(bars.length).toBeGreaterThanOrEqual(3);
  });

  it('shows drift marker when recent 5 plans have ≥ 1-SD shift in review', () => {
    // 10 plans: prior 5 have low review time, recent 5 have high review time
    // prior 5: review = 60_000 ms each
    // recent 5: review = 600_000 ms each
    // The shift is 540_000 ms; SD of all 10 values: compute manually.
    // Values: [60,60,60,60,60,600,600,600,600,600] in thousands
    // Mean = 330, variance = ((60-330)^2 * 5 + (600-330)^2 * 5) / 10
    //      = (72900 * 5 + 72900 * 5) / 10 = 72900 → SD = 270 thousand ms
    // |median(recent5) - median(prior5)| = |600k - 60k| = 540k >> SD = 270k → triggers
    const now = new Date('2026-04-28T10:00:00Z').getTime();
    const plans: PlanTimingSummary[] = [];
    // prior 5 (oldest)
    for (let i = 9; i >= 5; i--) {
      plans.push(
        makePlan({
          startedAt: new Date(now - i * 86_400_000).toISOString(),
          durationMs: 300_000,
          byCategory: { dev: 240_000, review: 60_000 },
        }),
      );
    }
    // recent 5 (newest)
    for (let i = 4; i >= 0; i--) {
      plans.push(
        makePlan({
          startedAt: new Date(now - i * 86_400_000).toISOString(),
          durationMs: 800_000,
          byCategory: { dev: 200_000, review: 600_000 },
        }),
      );
    }

    vi.mocked(useAppTiming).mockReturnValue({
      data: makeTimingData(plans),
      isLoading: false,
      error: null,
    } as ReturnType<typeof useAppTiming>);

    render(<PerformanceTab appId={APP_ID} app={APP} />);

    // Drift banner should appear
    expect(screen.getByText(/statistical drift detected/i)).toBeInTheDocument();
    // Review should be named in the drift summary
    expect(screen.getByText(/review/i, { selector: 'span' })).toBeInTheDocument();
  });

  it('shows cohort accumulating pill when cohort returns COHORT_ACCUMULATING', () => {
    vi.mocked(useCohort).mockReturnValue({
      data: COHORT_ACCUMULATING,
      isLoading: false,
      error: null,
    } as ReturnType<typeof useCohort>);

    const plans = [makePlan({ startedAt: '2026-04-28T08:00:00Z', durationMs: 600_000 })];

    vi.mocked(useAppTiming).mockReturnValue({
      data: makeTimingData(plans),
      isLoading: false,
      error: null,
    } as ReturnType<typeof useAppTiming>);

    render(<PerformanceTab appId={APP_ID} app={APP} />);

    expect(screen.getByTestId('cohort-accumulating')).toBeInTheDocument();
    expect(screen.getByText(/cohort accumulating/i)).toBeInTheDocument();
  });

  it('sorts plans by duration ascending', () => {
    const plans = [
      makePlan({ startedAt: '2026-04-26T10:00:00Z', durationMs: 900_000, planId: 'plan-c' }),
      makePlan({ startedAt: '2026-04-27T10:00:00Z', durationMs: 300_000, planId: 'plan-a' }),
      makePlan({ startedAt: '2026-04-28T10:00:00Z', durationMs: 600_000, planId: 'plan-b' }),
    ];

    vi.mocked(useAppTiming).mockReturnValue({
      data: makeTimingData(plans),
      isLoading: false,
      error: null,
    } as ReturnType<typeof useAppTiming>);

    render(<PerformanceTab appId={APP_ID} app={APP} />);

    // Click Duration sort button once (desc by default)
    const durationBtn = screen.getByRole('button', { name: /sort by duration/i });
    fireEvent.click(durationBtn);

    // Now sorted desc: 15m, 10m, 5m
    const cells = screen.getAllByText(/^\d+m(\s\d+s)?$/);
    // First visible duration should be 15m (900_000 ms)
    expect(cells[0].textContent).toMatch(/15m/);

    // Click again to flip to ascending: 5m, 10m, 15m
    fireEvent.click(durationBtn);
    const cellsAsc = screen.getAllByText(/^\d+m(\s\d+s)?$/);
    expect(cellsAsc[0].textContent).toMatch(/5m/);
  });

  it('sorts plans by duration descending', () => {
    const plans = [
      makePlan({ startedAt: '2026-04-26T10:00:00Z', durationMs: 300_000, planId: 'plan-a' }),
      makePlan({ startedAt: '2026-04-27T10:00:00Z', durationMs: 900_000, planId: 'plan-c' }),
      makePlan({ startedAt: '2026-04-28T10:00:00Z', durationMs: 600_000, planId: 'plan-b' }),
    ];

    vi.mocked(useAppTiming).mockReturnValue({
      data: makeTimingData(plans),
      isLoading: false,
      error: null,
    } as ReturnType<typeof useAppTiming>);

    render(<PerformanceTab appId={APP_ID} app={APP} />);

    const durationBtn = screen.getByRole('button', { name: /sort by duration/i });
    // Click once → desc
    fireEvent.click(durationBtn);

    const cells = screen.getAllByText(/^\d+m(\s\d+s)?$/);
    // First row should be 15m (900_000 ms)
    expect(cells[0].textContent).toMatch(/15m/);
  });
});
