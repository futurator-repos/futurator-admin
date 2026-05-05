'use client';
import { useEffect, useRef, useState } from 'react';
import { api } from '@/lib/api-client';
import type { PartyEvent, PartyEventsResponse } from '@/types/party';

/**
 * Poll bootstrap events for a given bootstrap job. Stops automatically on
 * `party.bootstrap.completed` or `party.bootstrap.failed`.
 */
export function useBootstrapEvents(jobId: string | null) {
  const [events, setEvents] = useState<PartyEvent[]>([]);
  const [terminal, setTerminal] = useState<'completed' | 'failed' | null>(null);
  const lastSeq = useRef('000000');

  useEffect(() => {
    if (!jobId) return;
    // Reset scroll/poll state when the tracked jobId flips. React's set-state-in-
    // effect guard is deliberately bypassed: we need the reset to happen
    // synchronously so the first poll result doesn't append to stale events.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setEvents([]);
    setTerminal(null);
    lastSeq.current = '000000';

    let cancelled = false;
    const interval = setInterval(async () => {
      if (cancelled) return;
      try {
        const data = await api.get<PartyEventsResponse>(
          `/agent-jobs/${jobId}/events?after=${lastSeq.current}`,
        );
        if (data.events.length > 0) {
          setEvents((prev) => [...prev, ...data.events]);
          lastSeq.current = String(data.lastSeq).padStart(6, '0');
          const last = data.events[data.events.length - 1];
          if (last.eventType === 'party.bootstrap.completed') {
            setTerminal('completed');
            clearInterval(interval);
          } else if (last.eventType === 'party.bootstrap.failed') {
            setTerminal('failed');
            clearInterval(interval);
          }
        }
      } catch {
        // retry on next tick
      }
    }, 1500);

    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [jobId]);

  return { events, terminal };
}
