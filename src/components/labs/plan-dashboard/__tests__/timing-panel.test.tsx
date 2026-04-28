/**
 * Story 1.8.4 — TimingPanel tests
 *
 * Mocks:
 *   - @/lib/api-client — prevents real network calls.
 *   - @/hooks/use-plan-timing — returns synthetic data so we don't need a
 *     full TanStack Query provider.
 *
 * Test rows:
 *   1. Renders stacked bar segments matching data percentages.
 *   2. Renders total elapsed in mm:ss format.
 *   3. Live state shows polling indicator; non-live state hides it.
 *   4. Forensic export button is present and triggers download handler.
 *   5. A11y: stacked bar has role="img" with descriptive aria-label.
 *   6. Legend shows per-category percentages.
 *   7. Expand/collapse per-story breakdown.
 *   8. Empty (zero slices) renders a no-data bar.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import type { PlanTimingData } from '@/hooks/use-plan-timing';

// ── Mocks ──────────────────────────────────────────────────────────────────

// Mock api-client first so it never makes real network calls.
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

// We mock the hook so tests are isolated from TanStack Query internals.
vi.mock('@/hooks/use-plan-timing', () => ({
  usePlanTiming: vi.fn(),
}));

import { usePlanTiming } from '@/hooks/use-plan-timing';
import { TimingPanel } from '../timing-panel';

// ── Synthetic data ──────────────────────────────────────────────────────────

const PLAN_ID = 'plan-test-001';

function makeTiming(overrides: Partial<PlanTimingData> = {}): PlanTimingData {
  return {
    planId: PLAN_ID,
    slices: [
      // dev slices across two jobs
      {
        jobId: 'job-a',
        eventSeq: '1',
        category: 'dev',
        startedAt: '2026-04-28T10:00:00Z',
        endedAt: '2026-04-28T10:03:48Z',
        durationMs: 228_000, // 3m 48s → 38%
        agentRole: 'dev',
        eventType: 'tool_use',
      },
      {
        jobId: 'job-a',
        eventSeq: '2',
        category: 'review',
        startedAt: '2026-04-28T10:03:48Z',
        endedAt: '2026-04-28T10:06:18Z',
        durationMs: 150_000, // 2m 30s → 25%
        agentRole: 'reviewer',
        eventType: 'text_delta',
      },
      {
        jobId: 'job-b',
        eventSeq: '1',
        category: 'compile',
        startedAt: '2026-04-28T10:06:18Z',
        endedAt: '2026-04-28T10:07:42Z',
        durationMs: 84_000, // 1m 24s → 14%
        agentRole: 'orchestrator',
        eventType: 'wave_start',
      },
      {
        jobId: 'job-b',
        eventSeq: '2',
        category: 'fix',
        startedAt: '2026-04-28T10:07:42Z',
        endedAt: '2026-04-28T10:09:18Z',
        durationMs: 96_000, // 1m 36s → 16%
        agentRole: 'dev',
        eventType: 'tool_use',
      },
      {
        jobId: 'job-b',
        eventSeq: '3',
        category: 'git',
        startedAt: '2026-04-28T10:09:18Z',
        endedAt: '2026-04-28T10:10:00Z',
        durationMs: 42_000, // 42s → 7%
        agentRole: 'orchestrator',
        eventType: 'tool_use',
      },
    ],
    aggregate: {
      byCategory: {
        dev: { totalMs: 228_000, count: 1 },
        review: { totalMs: 150_000, count: 1 },
        compile: { totalMs: 84_000, count: 1 },
        fix: { totalMs: 96_000, count: 1 },
        git: { totalMs: 42_000, count: 1 },
      },
      totalMs: 600_000,
    },
    planTotalMs: 600_000, // 10 min wall-clock
    isLive: false,
    ...overrides,
  };
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe('TimingPanel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders stacked bar segments matching data percentages', () => {
    vi.mocked(usePlanTiming).mockReturnValue({
      data: makeTiming(),
      isLoading: false,
      error: null,
      sliceCountUnchanged: false,
    } as ReturnType<typeof usePlanTiming>);

    render(<TimingPanel planId={PLAN_ID} />);

    // Segments are rendered as divs with aria-label="Category: pct%".
    // Use getAllByLabelText to handle multiple matches and assert at least one.
    // dev = 228000/600000 = 38%
    const devSegments = screen.getAllByLabelText(/^dev.*38/i);
    expect(devSegments.length).toBeGreaterThanOrEqual(1);
    // review = 150000/600000 = 25%
    const reviewSegments = screen.getAllByLabelText(/^review.*25/i);
    expect(reviewSegments.length).toBeGreaterThanOrEqual(1);
  });

  it('renders total elapsed in mm:ss format (10:00 for 600s)', () => {
    vi.mocked(usePlanTiming).mockReturnValue({
      data: makeTiming(),
      isLoading: false,
      error: null,
      sliceCountUnchanged: false,
    } as ReturnType<typeof usePlanTiming>);

    render(<TimingPanel planId={PLAN_ID} />);

    // 600_000 ms = 10 minutes → "10:00"
    expect(screen.getByText('10:00')).toBeInTheDocument();
  });

  it('shows live indicator when isLive === true', () => {
    vi.mocked(usePlanTiming).mockReturnValue({
      data: makeTiming({ isLive: true }),
      isLoading: false,
      error: null,
      sliceCountUnchanged: false,
    } as ReturnType<typeof usePlanTiming>);

    render(<TimingPanel planId={PLAN_ID} />);

    expect(screen.getByTestId('live-indicator')).toBeInTheDocument();
  });

  it('hides live indicator when isLive === false', () => {
    vi.mocked(usePlanTiming).mockReturnValue({
      data: makeTiming({ isLive: false }),
      isLoading: false,
      error: null,
      sliceCountUnchanged: false,
    } as ReturnType<typeof usePlanTiming>);

    render(<TimingPanel planId={PLAN_ID} />);

    expect(screen.queryByTestId('live-indicator')).not.toBeInTheDocument();
  });

  it('forensic export button is present with correct aria-label', () => {
    vi.mocked(usePlanTiming).mockReturnValue({
      data: makeTiming(),
      isLoading: false,
      error: null,
      sliceCountUnchanged: false,
    } as ReturnType<typeof usePlanTiming>);

    render(<TimingPanel planId={PLAN_ID} />);

    const btn = screen.getByTestId('forensic-export-button');
    expect(btn).toBeInTheDocument();
    expect(btn).toHaveAttribute('aria-label', expect.stringContaining(PLAN_ID));
  });

  it('forensic export button is present and triggers api.fetch on click', async () => {
    // This test focuses on the button being present and the click handler
    // calling the api — we avoid complex DOM manipulation that could pollute
    // subsequent tests.
    const { api } = await import('@/lib/api-client');
    vi.mocked(api.fetch).mockResolvedValue({ planId: PLAN_ID, slices: [] });

    // Provide URL.createObjectURL + revokeObjectURL stubs
    Object.defineProperty(URL, 'createObjectURL', {
      value: vi.fn(() => 'blob:mock'),
      writable: true,
    });
    Object.defineProperty(URL, 'revokeObjectURL', { value: vi.fn(), writable: true });
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});

    vi.mocked(usePlanTiming).mockReturnValue({
      data: makeTiming(),
      isLoading: false,
      error: null,
      sliceCountUnchanged: false,
    } as ReturnType<typeof usePlanTiming>);

    render(<TimingPanel planId={PLAN_ID} />);

    const btn = screen.getByTestId('forensic-export-button');
    expect(btn).toBeInTheDocument();
    fireEvent.click(btn);

    await vi.waitFor(() => {
      expect(api.fetch).toHaveBeenCalledWith(
        `/plans/${PLAN_ID}/timing/forensic`,
        expect.any(Object),
      );
    });
  });

  it('stacked bar has role="img" with descriptive aria-label', () => {
    vi.mocked(usePlanTiming).mockReturnValue({
      data: makeTiming(),
      isLoading: false,
      error: null,
      sliceCountUnchanged: false,
    } as ReturnType<typeof usePlanTiming>);

    render(<TimingPanel planId={PLAN_ID} />);

    // The main stacked bar has role="img" with a label starting "Timing breakdown"
    // There may be multiple role="img" elements (segments also have aria-label).
    // The main bar's aria-label starts with "Timing breakdown".
    const bars = screen.getAllByRole('img');
    const mainBar = bars.find((el) =>
      el.getAttribute('aria-label')?.startsWith('Timing breakdown'),
    );
    expect(mainBar).toBeDefined();
    expect(mainBar?.getAttribute('aria-label')).toMatch(/Dev/);
  });

  it('legend shows per-category percentages', () => {
    vi.mocked(usePlanTiming).mockReturnValue({
      data: makeTiming(),
      isLoading: false,
      error: null,
      sliceCountUnchanged: false,
    } as ReturnType<typeof usePlanTiming>);

    const { container } = render(<TimingPanel planId={PLAN_ID} />);

    // Percentages are rendered as "38.0" + "%" in separate spans.
    // Check the full container text content which concatenates all text nodes.
    expect(container.textContent).toMatch(/38\.0/);
    expect(container.textContent).toMatch(/25\.0/);
  });

  it('expand/collapse per-story breakdown', () => {
    vi.mocked(usePlanTiming).mockReturnValue({
      data: makeTiming(),
      isLoading: false,
      error: null,
      sliceCountUnchanged: false,
    } as ReturnType<typeof usePlanTiming>);

    const { container } = render(<TimingPanel planId={PLAN_ID} />);

    // Find the collapse/expand button by its aria-label (set on the button directly)
    const expandBtn = screen.getByRole('button', { name: /expand per-story breakdown/i });
    expect(expandBtn).toBeInTheDocument();

    // Initially collapsed — no job breakdown text
    expect(container.textContent).not.toMatch(/per-job breakdown/i);

    fireEvent.click(expandBtn);

    // After click — breakdown appears (2 jobs: job-a, job-b)
    expect(container.textContent).toMatch(/per-job breakdown/i);
    expect(container.textContent).toMatch(/2 jobs/i);
  });

  it('renders no-data bar when slices are empty', () => {
    vi.mocked(usePlanTiming).mockReturnValue({
      data: makeTiming({ slices: [], aggregate: { byCategory: {}, totalMs: 0 }, planTotalMs: 0 }),
      isLoading: false,
      error: null,
      sliceCountUnchanged: false,
    } as ReturnType<typeof usePlanTiming>);

    const { container } = render(<TimingPanel planId={PLAN_ID} />);

    // When there are no slices, the StackedBar renders the no-data placeholder.
    // It has role="img" with aria-label="No timing data yet".
    // We also check via container presence as a fallback.
    expect(container.firstChild).not.toBeNull(); // Component rendered something
    const noDataEl = container.querySelector('[aria-label="No timing data yet"]');
    expect(noDataEl).not.toBeNull();
  });
});
