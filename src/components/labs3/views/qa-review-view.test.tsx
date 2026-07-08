/**
 * qa-review-view.test.tsx — the FROZEN CONTRACT readiness rule, rendered.
 *
 * The READY-TO-DELIVER chip in the deployed-app QA path must be:
 *   - green "Ready to deliver" ONLY when isDeliverable (qaVerifiedAt present, or
 *     an approved verdict);
 *   - red "QA blocking" when a blocking verdict exists and not deliverable;
 *   - neutral "QA pending — unverified" when no verdict yet (NOT green).
 *
 * We mock only useP3QaReport; the pure readiness helpers stay real so we test
 * the actual rule, not a stub of it.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import type { P3QaReport, P3QaVerdict } from '@/types/qa-review-p3';
import type { UseP3QaReportResult } from '@/hooks/use-p3-qa-report';

// Mutable hook return the mock reads on each render.
let hookResult: UseP3QaReportResult;

vi.mock('@/hooks/use-p3-qa-report', async (importActual) => {
  const actual = await importActual<typeof import('@/hooks/use-p3-qa-report')>();
  return { ...actual, useP3QaReport: () => hookResult };
});

import { QaReviewView } from './qa-review-view';

function makeReport(over: Partial<P3QaReport> = {}): P3QaReport {
  return {
    planId: 'plan-1',
    qaCommitSha: 'abc123',
    devUrl: 'https://dev.futurator.ai/plan-1/',
    status: 'idle',
    journeys: [],
    vqa: [],
    wiring: { orphanModules: [], blocking: false },
    ...over,
  };
}

function makeVerdict(over: Partial<P3QaVerdict> = {}): P3QaVerdict {
  return {
    status: 'pass',
    blocking: false,
    ranAtSha: 'abc123',
    journeys: [],
    vqa: [],
    wiring: { orphanModules: [], blocking: false },
    ...over,
  };
}

function setHook(over: Partial<UseP3QaReportResult>) {
  hookResult = {
    enabled: true,
    report: null,
    verdict: null,
    isLoading: false,
    isError: false,
    error: null,
    refetch: () => {},
    ...over,
  };
}

function renderView() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  function Wrap({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
  }
  return render(
    <Wrap>
      <QaReviewView planId="plan-1" appId="app-1" stories={[]} />
    </Wrap>,
  );
}

describe('QaReviewView — readiness chip (FROZEN CONTRACT)', () => {
  beforeEach(() => setHook({}));

  it('renders GREEN "Ready to deliver" when qaVerifiedAt is present', () => {
    setHook({
      report: makeReport({ status: 'passed', qaVerifiedAt: '2026-07-08T00:00:00.000Z' }),
      verdict: makeVerdict(),
    });
    renderView();
    const chip = screen.getByTestId('qa-readiness-chip');
    expect(chip.getAttribute('data-readiness')).toBe('verified');
    expect(screen.getByText('Ready to deliver')).toBeInTheDocument();
  });

  it('renders GREEN "Ready to deliver" when the verdict is operator-approved (no qaVerifiedAt)', () => {
    setHook({
      report: makeReport({ status: 'passed' }),
      verdict: makeVerdict({ decision: 'approved' }),
    });
    renderView();
    expect(screen.getByTestId('qa-readiness-chip').getAttribute('data-readiness')).toBe('verified');
  });

  it('renders RED "QA blocking" when a blocking verdict exists and not deliverable', () => {
    setHook({
      report: makeReport({ status: 'failed' }),
      verdict: makeVerdict({ status: 'fail', blocking: true }),
    });
    renderView();
    const chip = screen.getByTestId('qa-readiness-chip');
    expect(chip.getAttribute('data-readiness')).toBe('blocking');
    expect(screen.getByText('QA blocking')).toBeInTheDocument();
  });

  it('renders NEUTRAL "QA pending" when a report exists but no verdict / no verified stamp', () => {
    setHook({ report: makeReport({ status: 'idle' }), verdict: null });
    renderView();
    const chip = screen.getByTestId('qa-readiness-chip');
    expect(chip.getAttribute('data-readiness')).toBe('pending');
    expect(screen.getByText(/QA pending/i)).toBeInTheDocument();
  });

  it('shows the fallback story view (no readiness chip) when the flag is off', () => {
    setHook({ enabled: false, report: null, verdict: null });
    renderView();
    expect(screen.queryByTestId('qa-readiness-chip')).toBeNull();
  });
});
