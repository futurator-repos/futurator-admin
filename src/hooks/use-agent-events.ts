'use client';
import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { api } from '@/lib/api-client';
import type { AgentEvent, AgentJobStatus } from '@/types/agent-orchestrator';

interface UseAgentEventsResult {
  events: AgentEvent[];
  isPolling: boolean;
  reset: () => void;
}

export function useAgentEvents(
  jobId: string | null,
  jobStatus: AgentJobStatus | undefined,
): UseAgentEventsResult {
  const [events, setEvents] = useState<AgentEvent[]>([]);
  const lastSeq = useRef('000000');
  const didFinalFetch = useRef(false);

  const isPolling = useMemo(() => {
    if (!jobId) return false;
    if (!jobStatus) return true;
    return jobStatus !== 'COMPLETED' && jobStatus !== 'FAILED';
  }, [jobId, jobStatus]);

  const reset = useCallback(() => {
    setEvents([]);
    lastSeq.current = '000000';
    didFinalFetch.current = false;
  }, []);

  // D5 (2026-06-22) — stale live-log root fix, part 1: reset the FETCH CURSOR
  // when the job changes (a retry mints a NEW jobId), so the new job's events
  // are fetched from seq 0. Otherwise lastSeq still holds the dead job's higher
  // cursor and the new job's early events (eventSeq < that) are silently skipped
  // by the `after=lastSeq` server filter. Refs only here — NO setState in an
  // effect (that trips react-hooks/set-state-in-effect + cascading renders).
  // The DISPLAY is scoped to the current job by the return-time filter below,
  // so a dead prior job's failures never render alongside the live run (pre-fix
  // they did, and every retry looked like "failing again" — misled the operator
  // 4× in the pacmanv3 session).
  useEffect(() => {
    lastSeq.current = '000000';
    didFinalFetch.current = false;
  }, [jobId]);

  useEffect(() => {
    if (!jobId) return;

    const isTerminal = jobStatus === 'COMPLETED' || jobStatus === 'FAILED';

    // If terminal and we already did the final fetch, don't start a new interval
    if (isTerminal && didFinalFetch.current) return;

    // dino1 (2026-06-10): a COMPLETED/FAILED job gets exactly ONE catch-up
    // fetch, and the API used to return at most 50 events for it — so any
    // story whose log exceeded 50 events appeared "cut" mid-DEV forever.
    // Drain pages (500/page, bounded) until a short page says we're caught up.
    const PAGE_LIMIT = 500;
    const interval = setInterval(
      async () => {
        try {
          for (let page = 0; page < 20; page++) {
            const data = await api.get<{ events: AgentEvent[]; lastSeq: string }>(
              `/agent-jobs/${jobId}/events?after=${lastSeq.current}&limit=${PAGE_LIMIT}`,
            );

            if (data.events.length > 0) {
              setEvents((prev) => [...prev, ...data.events]);
              lastSeq.current = String(data.lastSeq).padStart(6, '0');
            }

            if (data.events.length < PAGE_LIMIT) break;
          }

          if (isTerminal) {
            didFinalFetch.current = true;
            clearInterval(interval);
          }
        } catch {
          // Silently retry on next tick
        }
      },
      1000, // always 1s — no rapid 0ms polling
    );

    return () => clearInterval(interval);
  }, [jobId, jobStatus]);

  // D5 part 2: scope the returned events to the CURRENT job. The internal
  // `events` buffer may still hold a prior job's events (the poller only ever
  // appends); filtering on return guarantees the live-log shows ONLY this job's
  // stream — pure, no state mutation, so no cascading-render / ref-write lint.
  const scopedEvents = useMemo(
    () => (jobId ? events.filter((e) => String(e.jobId) === String(jobId)) : events),
    [events, jobId],
  );

  return { events: scopedEvents, isPolling, reset };
}
