/**
 * contract-gate.test.tsx — PR-8d ContractGate component tests.
 *
 * Covers the operator-facing gate added so plans with
 * `qaContractStatus === 'pending'` can finally advance to qa-execute.
 *
 * - Renders one row per classified test, grouped by epic→story.
 * - Header chip updates live when operator changes per-test level.
 * - Approve POSTs only the included tests with their edited levels.
 * - Reject POSTs to the reject endpoint with empty body.
 * - rejected status renders the compact summary with Re-classify CTA.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactElement } from 'react';

// Mock next/navigation since jsdom has no Next router.
vi.mock('next/navigation', () => ({
  usePathname: vi.fn(() => '/labs'),
  useSearchParams: vi.fn(() => new URLSearchParams()),
  useRouter: vi.fn(() => ({ replace: vi.fn(), push: vi.fn() })),
}));

import { ContractGate } from '../contract-gate';
import type { ContractClassifiedTest, QaContractDraft, QaReport } from '@/types/qa-report';
import { useAuthStore } from '@/stores/auth-store';

// ── Helpers ─────────────────────────────────────────────────────────

function renderWithQuery(ui: ReactElement) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } },
  });
  return render(<QueryClientProvider client={queryClient}>{ui}</QueryClientProvider>);
}

let postCalls: Array<{ url: string; body: unknown }> = [];

beforeEach(() => {
  postCalls = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      if (init?.method === 'POST') {
        postCalls.push({
          url: typeof url === 'string' ? url : String(url),
          body: init.body ? JSON.parse(String(init.body)) : null,
        });
      }
      return new Response(
        JSON.stringify({
          planId: 'P-1',
          jobId: 'job-x',
          stage: 'execute',
          testCount: 0,
          contractStatus: 'approved',
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    }),
  );
  // Auth required by the api-client even though the mock ignores headers.
  useAuthStore.setState({
    user: { id: 'op', email: 'op@x.com' } as never,
    tokens: {
      accessToken: 'tok',
      refreshToken: 'r',
      expiresAt: Date.now() + 3_600_000,
    } as never,
    isAuthenticated: true,
    isLoading: false,
  });
});

function classifiedTest(over: Partial<ContractClassifiedTest> = {}): ContractClassifiedTest {
  return {
    testId: 'VT-1',
    storyId: 'S-1',
    storyTitle: 'Story 1',
    epicId: 'E-1',
    epicLabel: 'E1',
    criteriaRef: 'AC-1',
    description: 'Test 1',
    expect: 'something pixel-perfect',
    level: 'L1',
    classifierReason: 'level set in source',
    estimatedCostUsd: 0.005,
    estimatedWallclockSec: 5,
    ...over,
  };
}

function contract(over: Partial<QaContractDraft> = {}): QaContractDraft {
  return {
    aggregateJobId: 'agg-1',
    status: 'pending',
    totalTests: 2,
    byLevel: { L0: 0, L1: 2, L2: 0 },
    estimatedCostUsd: 0.01,
    estimatedWallclockSec: 10,
    coverageWarnings: [],
    specificityWarnings: [],
    classifiedTests: [classifiedTest({ testId: 'VT-1' }), classifiedTest({ testId: 'VT-2' })],
    ...over,
  };
}

function report(
  contractOverride: QaContractDraft | undefined,
  executeStatus: 'queued-contract' | 'rejected' = 'queued-contract',
): QaReport {
  return {
    planId: 'P-1',
    rigor: 'mvp',
    autoRunQa: false,
    hasBrowserTests: true,
    verdict: 'needs-attention',
    ac: {
      verdict: 'pass',
      total: 0,
      pass: 0,
      fail: 0,
      pending: 0,
      failures: [],
      canManuallyApprove: false,
    },
    vqa: {
      verdict: 'pending',
      total: 2,
      pass: 0,
      fail: 0,
      pending: 2,
      thumbnails: [],
      failures: [],
      results: [],
      executeStatus,
      contract: contractOverride,
    },
    gate: {
      verdict: 'pass',
      activeChecks: ['compile', 'typecheck', 'lint', 'unit'],
      waveRows: [],
      tamperCountsByStory: {},
    },
    perEpic: [],
    qaRuns: [],
    attentionItems: [],
    runHistory: [],
    generatedAt: '2026-05-18T17:00:00Z',
  };
}

// ── Tests ──────────────────────────────────────────────────────────

describe('ContractGate — pending state', () => {
  it('renders one row per classified test grouped by epic→story', () => {
    renderWithQuery(<ContractGate report={report(contract())} planId="P-1" />);
    expect(screen.getByText('Operator review required')).toBeInTheDocument();
    expect(screen.getByLabelText('Include VT-1')).toBeInTheDocument();
    expect(screen.getByLabelText('Include VT-2')).toBeInTheDocument();
    expect(screen.getByText('Story 1')).toBeInTheDocument();
  });

  it('header chips show initial totals', () => {
    renderWithQuery(<ContractGate report={report(contract())} planId="P-1" />);
    expect(screen.getByText('2/2 tests')).toBeInTheDocument();
    expect(screen.getByText('L0 0 · L1 2 · L2 0')).toBeInTheDocument();
    expect(screen.getByText('~$0.010')).toBeInTheDocument();
  });

  it('unchecking a row updates the header total live', async () => {
    renderWithQuery(<ContractGate report={report(contract())} planId="P-1" />);
    fireEvent.click(screen.getByLabelText('Include VT-2'));
    await waitFor(() => expect(screen.getByText('1/2 tests')).toBeInTheDocument());
    expect(screen.getByText('L0 0 · L1 1 · L2 0')).toBeInTheDocument();
    expect(screen.getByText('~$0.005')).toBeInTheDocument();
  });

  it('changing a level recomputes cost', async () => {
    renderWithQuery(<ContractGate report={report(contract())} planId="P-1" />);
    fireEvent.change(screen.getByLabelText('Level for VT-1'), { target: { value: 'L2' } });
    await waitFor(() => expect(screen.getByText('L0 0 · L1 1 · L2 1')).toBeInTheDocument());
    // L1 ($0.005) + L2 ($0.05) = $0.055
    expect(screen.getByText('~$0.055')).toBeInTheDocument();
  });

  it('approve POSTs only included tests with edited levels', async () => {
    renderWithQuery(<ContractGate report={report(contract())} planId="P-1" />);

    // Drop VT-2 and bump VT-1 to L2.
    fireEvent.click(screen.getByLabelText('Include VT-2'));
    fireEvent.change(screen.getByLabelText('Level for VT-1'), { target: { value: 'L2' } });

    // Approve button label is dynamic; match by role + leading text.
    const approveBtn = screen.getByRole('button', { name: /approve 1 test/i });
    fireEvent.click(approveBtn);

    await waitFor(() => expect(postCalls.length).toBeGreaterThanOrEqual(1));
    const approveCall = postCalls.find((c) => c.url.endsWith('/qa-contract/approve'));
    expect(approveCall).toBeDefined();
    expect(approveCall!.body).toEqual({
      tests: [{ id: 'VT-1', level: 'L2' }],
    });
  });

  it('approve is disabled when all tests are excluded', async () => {
    renderWithQuery(<ContractGate report={report(contract())} planId="P-1" />);
    fireEvent.click(screen.getByLabelText('Include VT-1'));
    fireEvent.click(screen.getByLabelText('Include VT-2'));
    const approveBtn = screen.getByRole('button', { name: /approve 0 tests/i });
    expect(approveBtn).toBeDisabled();
  });

  it('reject POSTs to the reject endpoint', async () => {
    renderWithQuery(<ContractGate report={report(contract())} planId="P-1" />);
    fireEvent.click(screen.getByRole('button', { name: /reject — skip qa/i }));
    await waitFor(() => {
      const call = postCalls.find((c) => c.url.endsWith('/qa-contract/reject'));
      expect(call).toBeDefined();
    });
  });

  it('renders coverage + specificity warnings when present', () => {
    renderWithQuery(
      <ContractGate
        report={report(
          contract({
            coverageWarnings: [{ refId: 'AC-2', message: 'AC-2 needs a test' }],
            specificityWarnings: [{ refId: 'VT-1', message: 'VT-1 expect is vague' }],
          }),
        )}
        planId="P-1"
      />,
    );
    expect(screen.getByText(/AC-2 needs a test/)).toBeInTheDocument();
    expect(screen.getByText(/VT-1 expect is vague/)).toBeInTheDocument();
  });
});

describe('ContractGate — rejected state', () => {
  it('renders the compact rejected summary with re-classify CTA', () => {
    renderWithQuery(
      <ContractGate
        report={report(
          contract({
            status: 'rejected',
            decidedBy: 'op@x.com',
            decidedAt: new Date(Date.now() - 5 * 60_000).toISOString(),
          }),
          'rejected',
        )}
        planId="P-1"
      />,
    );
    expect(screen.getByText('QA skipped')).toBeInTheDocument();
    expect(screen.getByText(/Rejected by op@x.com/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /re-classify/i })).toBeInTheDocument();
  });

  it('re-classify POSTs to qa-review (re-runs aggregate)', async () => {
    renderWithQuery(
      <ContractGate
        report={report(contract({ status: 'rejected', decidedBy: 'op' }), 'rejected')}
        planId="P-1"
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: /re-classify/i }));
    await waitFor(() => {
      const call = postCalls.find((c) => c.url.endsWith('/qa-review'));
      expect(call).toBeDefined();
    });
  });
});

describe('ContractGate — no-op states', () => {
  it('renders nothing when contract is missing', () => {
    const { container } = renderWithQuery(<ContractGate report={report(undefined)} planId="P-1" />);
    expect(container).toBeEmptyDOMElement();
  });

  it('renders nothing when executeStatus is queued-execute (out of gate scope)', () => {
    const r = report(contract());
    r.vqa.executeStatus = 'queued-execute';
    const { container } = renderWithQuery(<ContractGate report={r} planId="P-1" />);
    expect(container).toBeEmptyDOMElement();
  });
});
