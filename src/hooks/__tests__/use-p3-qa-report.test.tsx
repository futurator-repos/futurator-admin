/**
 * Tests for use-p3-qa-report — QA Review W2 plan-keyed hooks.
 *
 *   - computeP3QaRefetchInterval: fast (3s) while 'running', idle otherwise.
 *   - isP3QaReviewFlagEnabled / useP3QaReport: enabled=false falls back when
 *     the client flag is off (NEXT_PUBLIC_P3_QA_REVIEW === 'false').
 *   - useApproveP3Qa / useSendBackP3Qa: POST the plan-keyed URLs (not the
 *     legacy per-epic send-back path).
 */

import { act, renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
import type { P3QaReport } from '@/types/qa-review-p3';

// ── Mock the api-client so hooks hit an in-test fake instead of network ──
const getMock = vi.fn();
const postMock = vi.fn();
vi.mock('@/lib/api-client', () => ({
  api: {
    get: (...args: unknown[]) => getMock(...args),
    post: (...args: unknown[]) => postMock(...args),
  },
}));

import {
  computeP3QaRefetchInterval,
  isP3QaReviewFlagEnabled,
  useApproveP3Qa,
  useP3QaReport,
  useSendBackP3Qa,
} from '../use-p3-qa-report';

function makeReport(over: Partial<P3QaReport> = {}): P3QaReport {
  return {
    planId: 'plan-1',
    qaCommitSha: 'abc123',
    devUrl: 'https://dev.futurator.ai/plan-1',
    status: 'idle',
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

describe('computeP3QaRefetchInterval', () => {
  it('polls fast while running', () => {
    expect(computeP3QaRefetchInterval('running')).toBe(3_000);
  });

  it('is idle (no polling) for idle/passed/failed/undefined', () => {
    expect(computeP3QaRefetchInterval('idle')).toBe(false);
    expect(computeP3QaRefetchInterval('passed')).toBe(false);
    expect(computeP3QaRefetchInterval('failed')).toBe(false);
    expect(computeP3QaRefetchInterval(undefined)).toBe(false);
  });
});

describe('isP3QaReviewFlagEnabled', () => {
  const original = process.env.NEXT_PUBLIC_P3_QA_REVIEW;
  afterEach(() => {
    process.env.NEXT_PUBLIC_P3_QA_REVIEW = original;
  });

  it('defaults enabled when the env var is unset', () => {
    delete process.env.NEXT_PUBLIC_P3_QA_REVIEW;
    expect(isP3QaReviewFlagEnabled()).toBe(true);
  });

  it('is disabled only on an explicit "false"', () => {
    process.env.NEXT_PUBLIC_P3_QA_REVIEW = 'false';
    expect(isP3QaReviewFlagEnabled()).toBe(false);
  });
});

describe('useP3QaReport', () => {
  const original = process.env.NEXT_PUBLIC_P3_QA_REVIEW;
  beforeEach(() => {
    getMock.mockReset();
    postMock.mockReset();
  });
  afterEach(() => {
    process.env.NEXT_PUBLIC_P3_QA_REVIEW = original;
  });

  it('returns enabled=false and never fetches when the flag is off', async () => {
    process.env.NEXT_PUBLIC_P3_QA_REVIEW = 'false';
    const { result } = renderHook(() => useP3QaReport('plan-1'), { wrapper });
    expect(result.current.enabled).toBe(false);
    expect(result.current.report).toBeNull();
    expect(getMock).not.toHaveBeenCalled();
  });

  it('fetches and returns the report when enabled (idle status)', async () => {
    delete process.env.NEXT_PUBLIC_P3_QA_REVIEW;
    getMock.mockResolvedValue(makeReport({ status: 'idle' }));
    const { result } = renderHook(() => useP3QaReport('plan-1'), { wrapper });
    expect(result.current.enabled).toBe(true);
    await waitFor(() => expect(result.current.report?.status).toBe('idle'));
    expect(getMock).toHaveBeenCalledWith('/plans/plan-1/qa-review-p3');
  });

  it('polls repeatedly while status is running, and settles once passed', async () => {
    delete process.env.NEXT_PUBLIC_P3_QA_REVIEW;
    vi.useFakeTimers();
    try {
      let calls = 0;
      getMock.mockImplementation(() => {
        calls += 1;
        // First two calls return 'running'; then it flips to 'passed'.
        return Promise.resolve(makeReport({ status: calls <= 2 ? 'running' : 'passed' }));
      });

      const { result } = renderHook(() => useP3QaReport('plan-1'), { wrapper });

      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      expect(result.current.report?.status).toBe('running');
      const callsAfterFirst = calls;

      // Fast poll (3s) should have fired at least one more request while running.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(3_100);
      });
      expect(calls).toBeGreaterThan(callsAfterFirst);

      // Once 'passed', no further refetchInterval tick should fire (idle policy).
      await act(async () => {
        await vi.advanceTimersByTimeAsync(3_100);
      });
      expect(result.current.report?.status).toBe('passed');
      const callsAtPassed = calls;
      await act(async () => {
        await vi.advanceTimersByTimeAsync(10_000);
      });
      expect(calls).toBe(callsAtPassed);
    } finally {
      vi.useRealTimers();
    }
  });

  it('never throws into the tab on a malformed report — surfaces report=null', async () => {
    delete process.env.NEXT_PUBLIC_P3_QA_REVIEW;
    getMock.mockResolvedValue({ garbage: true });
    const { result } = renderHook(() => useP3QaReport('plan-1'), { wrapper });
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.report).toBeNull();
    expect(result.current.isError).toBe(false);
  });

  it('surfaces api.get rejection as report=null instead of an uncaught error', async () => {
    delete process.env.NEXT_PUBLIC_P3_QA_REVIEW;
    getMock.mockRejectedValue(new Error('network down'));
    const { result } = renderHook(() => useP3QaReport('plan-1'), { wrapper });
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.report).toBeNull();
    expect(result.current.isError).toBe(false);
  });
});

describe('useApproveP3Qa / useSendBackP3Qa — plan-keyed URLs', () => {
  beforeEach(() => {
    getMock.mockReset();
    postMock.mockReset();
  });

  it('POSTs the plan-keyed approve URL', async () => {
    postMock.mockResolvedValue({ planId: 'plan-1', verdict: {} });
    const { result } = renderHook(() => useApproveP3Qa('plan-1'), { wrapper });
    await act(async () => {
      await result.current.mutateAsync();
    });
    expect(postMock).toHaveBeenCalledWith('/plans/plan-1/qa/approve', {});
  });

  it('POSTs the plan-keyed send-back URL with the note, not the legacy epic path', async () => {
    postMock.mockResolvedValue({ planId: 'plan-1', verdict: {} });
    const { result } = renderHook(() => useSendBackP3Qa('plan-1'), { wrapper });
    await act(async () => {
      await result.current.mutateAsync({ note: 'orphan module blocks nav' });
    });
    expect(postMock).toHaveBeenCalledWith('/plans/plan-1/qa/send-back', {
      note: 'orphan module blocks nav',
    });
    expect(postMock).not.toHaveBeenCalledWith(
      expect.stringContaining('/epic-workflows/'),
      expect.anything(),
    );
  });
});
