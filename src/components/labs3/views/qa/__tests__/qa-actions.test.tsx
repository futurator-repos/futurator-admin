/**
 * qa-actions.test.tsx — QA-Review W2 verdict strip + Approve/Send-back CTAs.
 *
 * Pins:
 * - deriveQaActionState: no-report / stale / blocking / ready precedence
 *   (stale beats blocking).
 * - approveBlockReason: a reason string for every non-ready state, null
 *   when ready.
 * - Approve is disabled with its reason shown when the verdict is blocking
 *   or stale.
 * - Approve is enabled on an all-pass, non-stale verdict and calls the
 *   plan-keyed approve mutation (mocked api-client) with no body.
 * - Send-back calls the plan-keyed send-back mutation (mocked api-client).
 */

import { act, fireEvent, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
import type { P3QaVerdict } from '@/types/qa-review-p3';

// ── Mock the api-client so the real hooks hit an in-test fake ──
const getMock = vi.fn();
const postMock = vi.fn();
vi.mock('@/lib/api-client', () => ({
  api: {
    get: (...args: unknown[]) => getMock(...args),
    post: (...args: unknown[]) => postMock(...args),
  },
}));

import { QaActions, deriveQaActionState, approveBlockReason } from '../qa-actions';

const CURRENT_SHA = 'a1b2c3d4e5f6789';

function makeVerdict(over: Partial<P3QaVerdict> = {}): P3QaVerdict {
  return {
    status: 'pass',
    blocking: false,
    ranAtSha: CURRENT_SHA,
    journeys: [],
    vqa: [],
    wiring: { orphanModules: [], blocking: false },
    ...over,
  };
}

function wrapper({ children }: { children: ReactNode }) {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
}

describe('deriveQaActionState', () => {
  it('returns no-report when the verdict is null', () => {
    expect(deriveQaActionState(null, CURRENT_SHA)).toBe('no-report');
  });

  it('returns stale when ranAtSha differs from the current commit', () => {
    const v = makeVerdict({ ranAtSha: 'old-sha', blocking: false });
    expect(deriveQaActionState(v, CURRENT_SHA)).toBe('stale');
  });

  it('stale beats blocking (a stale report is untrustworthy either way)', () => {
    const v = makeVerdict({ ranAtSha: 'old-sha', blocking: true });
    expect(deriveQaActionState(v, CURRENT_SHA)).toBe('stale');
  });

  it('returns blocking when ranAtSha matches but the verdict blocks', () => {
    const v = makeVerdict({ ranAtSha: CURRENT_SHA, blocking: true });
    expect(deriveQaActionState(v, CURRENT_SHA)).toBe('blocking');
  });

  it('returns ready on an all-pass, current-commit verdict', () => {
    const v = makeVerdict({ ranAtSha: CURRENT_SHA, blocking: false });
    expect(deriveQaActionState(v, CURRENT_SHA)).toBe('ready');
  });
});

describe('approveBlockReason', () => {
  it('is null when ready', () => {
    expect(approveBlockReason('ready', makeVerdict(), CURRENT_SHA)).toBeNull();
  });

  it('explains no-report', () => {
    expect(approveBlockReason('no-report', null, CURRENT_SHA)).toMatch(/no qa verdict/i);
  });

  it('explains stale with both SHAs', () => {
    const v = makeVerdict({ ranAtSha: '0ldc0mmit' });
    const reason = approveBlockReason('stale', v, CURRENT_SHA);
    expect(reason).toMatch(/stale/i);
    expect(reason).toMatch(/0ldc0mm/);
    expect(reason).toMatch(/a1b2c3d/);
  });

  it('explains blocking with journey/VQA/orphan counts', () => {
    const v = makeVerdict({
      blocking: true,
      journeys: [
        { id: 'j1', title: 'Sign up', acRefs: [], verdict: 'fail', steps: [] },
        { id: 'j2', title: 'Log in', acRefs: [], verdict: 'pass', steps: [] },
      ],
      vqa: [
        {
          journeyId: 'j1',
          stepLabel: 'submit',
          verdict: 'fail',
          rationale: 'layout broke',
          beforeShotUrl: '',
          afterShotUrl: '',
        },
      ],
      wiring: { orphanModules: ['src/foo.ts'], blocking: true },
    });
    const reason = approveBlockReason('blocking', v, CURRENT_SHA);
    expect(reason).toMatch(/1 journey failed/);
    expect(reason).toMatch(/1 VQA fail/);
    expect(reason).toMatch(/1 orphan module/);
  });

  it('falls back to a generic blocking reason when no per-lane detail applies', () => {
    const v = makeVerdict({ blocking: true });
    expect(approveBlockReason('blocking', v, CURRENT_SHA)).toBe('Blocking issues present.');
  });
});

describe('QaActions', () => {
  beforeEach(() => {
    getMock.mockReset();
    postMock.mockReset();
  });
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('disables Approve and shows the reason on a blocking verdict', () => {
    const verdict = makeVerdict({
      blocking: true,
      journeys: [{ id: 'j1', title: 'Sign up', acRefs: [], verdict: 'fail', steps: [] }],
    });
    render(<QaActions planId="plan-1" verdict={verdict} currentQaCommitSha={CURRENT_SHA} />, {
      wrapper,
    });
    const approveBtn = screen.getByRole('button', { name: /approve disabled/i });
    expect(approveBtn).toBeDisabled();
    expect(screen.getByText(/1 journey failed/)).toBeInTheDocument();
  });

  it('disables Approve and shows the reason on a stale verdict', () => {
    const verdict = makeVerdict({ ranAtSha: 'old-sha-000', blocking: false });
    render(<QaActions planId="plan-1" verdict={verdict} currentQaCommitSha={CURRENT_SHA} />, {
      wrapper,
    });
    const approveBtn = screen.getByRole('button', { name: /approve disabled/i });
    expect(approveBtn).toBeDisabled();
    expect(screen.getByText(/re-run qa before approving/i)).toBeInTheDocument();
  });

  it('enables Approve on an all-pass verdict and calls the plan-keyed approve mutation', async () => {
    postMock.mockResolvedValue({ planId: 'plan-1', verdict: {} });
    const verdict = makeVerdict({ ranAtSha: CURRENT_SHA, blocking: false });
    render(<QaActions planId="plan-1" verdict={verdict} currentQaCommitSha={CURRENT_SHA} />, {
      wrapper,
    });
    const approveBtn = screen.getByRole('button', { name: /approve and promote/i });
    expect(approveBtn).toBeEnabled();

    await act(async () => {
      fireEvent.click(approveBtn);
    });

    expect(postMock).toHaveBeenCalledWith('/plans/plan-1/qa/approve', {});
  });

  it('calls the plan-keyed send-back mutation when Send back is clicked', async () => {
    postMock.mockResolvedValue({ planId: 'plan-1', verdict: {} });
    const verdict = makeVerdict({
      blocking: true,
      journeys: [{ id: 'j1', title: 'Sign up', acRefs: [], verdict: 'fail', steps: [] }],
    });
    render(<QaActions planId="plan-1" verdict={verdict} currentQaCommitSha={CURRENT_SHA} />, {
      wrapper,
    });

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /send back/i }));
    });

    expect(postMock).toHaveBeenCalledWith('/plans/plan-1/qa/send-back', { note: undefined });
  });
});
