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

  useEffect(() => {
    if (!jobId) return;

    const isTerminal = jobStatus === 'COMPLETED' || jobStatus === 'FAILED';

    // If terminal and we already did the final fetch, don't start a new interval
    if (isTerminal && didFinalFetch.current) return;

    const interval = setInterval(
      async () => {
        try {
          const data = await api.get<{ events: AgentEvent[]; lastSeq: string }>(
            `/agent-jobs/${jobId}/events?after=${lastSeq.current}`,
          );

          if (data.events.length > 0) {
            setEvents((prev) => [...prev, ...data.events]);
            lastSeq.current = String(data.lastSeq).padStart(6, '0');
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

  return { events, isPolling, reset };
}
