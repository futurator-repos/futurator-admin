/**
 * Tests for use-agent-events — the per-story live-log poller.
 *
 * Focus: D5 (2026-06-22) stale live-log root fix. When a story's job changes
 * (a retry mints a new jobId), the hook must CLEAR the accumulated events so a
 * dead prior job's failures don't render alongside the live run, and must reset
 * the `after=<seq>` cursor so the new job's early events aren't skipped.
 */

import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentEvent } from '@/types/agent-orchestrator';

// ── Mock the api-client so the poller hits an in-test fake instead of network ──
const getMock = vi.fn();
vi.mock('@/lib/api-client', () => ({
  api: {
    get: (...args: unknown[]) => getMock(...args),
  },
}));

import { useAgentEvents } from '../use-agent-events';

function makeEvent(jobId: string, seq: number): AgentEvent {
  return {
    jobId,
    eventSeq: String(seq).padStart(6, '0'),
    timestamp: new Date(0).toISOString(),
    agentName: 'DEV',
    type: 'text_delta',
    text: `${jobId}#${seq}`,
  } as unknown as AgentEvent;
}

describe('useAgentEvents — D5 reset on jobId change', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    getMock.mockReset();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('clears events and the seq cursor when jobId changes (retry)', async () => {
    // First job (dead): one page of events then caught up.
    getMock.mockImplementation((url: string) => {
      if (url.includes('/agent-jobs/job-dead/events')) {
        // Only return events when the cursor is still at the start; otherwise
        // a short empty page signals "caught up".
        if (url.includes('after=000000')) {
          return Promise.resolve({ events: [makeEvent('job-dead', 1)], lastSeq: '000050' });
        }
        return Promise.resolve({ events: [], lastSeq: '000050' });
      }
      if (url.includes('/agent-jobs/job-live/events')) {
        // The NEW job's first event has seq 2 — LOWER than the dead job's
        // last seq (50). If the cursor weren't reset, `after=000050` would
        // skip it. The test asserts the request goes out with after=000000.
        if (url.includes('after=000000')) {
          return Promise.resolve({ events: [makeEvent('job-live', 2)], lastSeq: '000002' });
        }
        return Promise.resolve({ events: [], lastSeq: '000002' });
      }
      return Promise.resolve({ events: [], lastSeq: '000000' });
    });

    const { result, rerender } = renderHook(({ jobId, status }) => useAgentEvents(jobId, status), {
      initialProps: { jobId: 'job-dead', status: 'RUNNING' as const },
    });

    // Drain the first poll tick.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1100);
    });
    expect(result.current.events.length).toBe(1);
    expect(result.current.events[0].jobId).toBe('job-dead');

    // Retry → new jobId. The hook must drop the dead job's event.
    await act(async () => {
      rerender({ jobId: 'job-live', status: 'RUNNING' as const });
    });
    // After the rerender's reset effect, the dead job's event is cleared.
    expect(result.current.events.find((e) => e.jobId === 'job-dead')).toBeUndefined();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1100);
    });
    expect(result.current.events.length).toBe(1);
    expect(result.current.events[0].jobId).toBe('job-live');

    // The live job was queried from seq 0 (cursor reset), not from the dead
    // job's 000050 — otherwise its seq-2 event would have been filtered out.
    const liveCallUrls = getMock.mock.calls
      .map((c) => String(c[0]))
      .filter((u) => u.includes('/agent-jobs/job-live/events'));
    expect(liveCallUrls.some((u) => u.includes('after=000000'))).toBe(true);
    expect(liveCallUrls.some((u) => u.includes('after=000050'))).toBe(false);
  });
});
