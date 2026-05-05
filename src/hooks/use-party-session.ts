'use client';
import { useEffect, useRef, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api-client';
import type {
  PartyEvent,
  PartyEventsResponse,
  PartySendMessageResponse,
  PartySession,
} from '@/types/party';

export function useSession(sessionId: string | null) {
  return useQuery({
    queryKey: ['party', 'session', sessionId],
    queryFn: () => api.get<PartySession>(`/party/sessions/${sessionId}`),
    enabled: !!sessionId,
    refetchInterval: (query) => {
      const s = query.state.data;
      if (!s) return false;
      // Poll fast while the turn is in flight so the UI transitions from
      // PROCESSING → ACTIVE (which clears the "thinking" indicator) within
      // one tick after the daemon closes the stream.
      return s.status === 'PROCESSING' ? 800 : false;
    },
    staleTime: 2_000,
  });
}

/**
 * Poll session-scoped events. Events are keyed by sessionId in the backend so
 * a single poll stream covers all turns.
 *
 * Polling cadence is adaptive:
 *   - 600 ms while PROCESSING (live streaming)
 *   - 600 ms after a token burst (likely more on the way)
 *   - 2 s when ACTIVE/IDLE
 *
 * Polling STOPS entirely once the session reaches a terminal-ish state with
 * no in-flight burst. We were previously polling ERROR sessions forever,
 * which (a) wastes API calls and (b) can cause adapter dedupe headaches if
 * the request races with status changes.
 *
 * Critically, the effect is keyed ONLY on sessionId — not on status. Earlier
 * code listed `status` as a dep, which caused the events array to reset on
 * every PROCESSING→ERROR flip and then the polling-loop closure to refetch
 * from after=000000, sometimes overlapping with an in-flight request and
 * producing duplicate events on the client. We capture status in a ref and
 * read the latest value inside the loop instead.
 */
export function useSessionEvents(sessionId: string | null, status?: PartySession['status']) {
  const [events, setEvents] = useState<PartyEvent[]>([]);
  const lastSeq = useRef('000000');
  const statusRef = useRef<PartySession['status'] | undefined>(status);

  // Keep the ref in sync without re-running the polling effect.
  useEffect(() => {
    statusRef.current = status;
  }, [status]);

  useEffect(() => {
    if (!sessionId) return;
    setEvents([]);
    lastSeq.current = '000000';

    let cancelled = false;
    let timeout: ReturnType<typeof setTimeout> | null = null;

    function nextDelay(justGotEvents: boolean): number | null {
      const current = statusRef.current;
      if (current === 'PROCESSING') return 600;
      if (justGotEvents) return 600; // burst tail — keep polling briefly
      // Terminal/idle-ish: no more events expected. Stop polling. The
      // session refetch will resurrect us if status flips back.
      if (current === 'ERROR' || current === 'ARCHIVED' || current === 'IDLE') {
        return null;
      }
      return 2000;
    }

    async function tick() {
      if (cancelled) return;
      let gotEvents = false;
      try {
        const data = await api.get<PartyEventsResponse>(
          `/party/sessions/${sessionId}/events?after=${lastSeq.current}`,
        );
        if (cancelled) return;
        if (data.events.length > 0) {
          // Advance the cursor BEFORE setEvents so a re-render that triggers
          // another tick can't refetch the same range.
          lastSeq.current = String(data.lastSeq).padStart(6, '0');
          setEvents((prev) => [...prev, ...data.events]);
          gotEvents = true;
        }
      } catch {
        // retry on next tick
      }
      if (cancelled) return;
      const delay = nextDelay(gotEvents);
      if (delay !== null) timeout = setTimeout(tick, delay);
    }

    void tick();

    return () => {
      cancelled = true;
      if (timeout) clearTimeout(timeout);
    };
  }, [sessionId]);

  return { events };
}

export function useSendMessageMutation(sessionId: string | null) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (content: string) => {
      if (!sessionId) throw new Error('sessionId is required');
      return api.post<PartySendMessageResponse>(`/party/sessions/${sessionId}/messages`, {
        content,
      });
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['party', 'session', sessionId] });
    },
  });
}

/**
 * Rename a session (PATCH topic). Optimistically updates the cache so the
 * header text snaps to the new value before the network round-trip.
 */
export function useRenameSessionMutation(sessionId: string | null) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (topic: string | null) => {
      if (!sessionId) throw new Error('sessionId is required');
      return api.patch<PartySession>(`/party/sessions/${sessionId}`, { topic });
    },
    onMutate: async (topic) => {
      if (!sessionId) return;
      await qc.cancelQueries({ queryKey: ['party', 'session', sessionId] });
      const prev = qc.getQueryData<PartySession>(['party', 'session', sessionId]);
      if (prev) {
        qc.setQueryData<PartySession>(['party', 'session', sessionId], {
          ...prev,
          topic: topic ?? undefined,
        });
      }
      return { prev };
    },
    onError: (_err, _vars, ctx) => {
      if (ctx?.prev && sessionId) {
        qc.setQueryData(['party', 'session', sessionId], ctx.prev);
      }
    },
    onSettled: () => {
      qc.invalidateQueries({ queryKey: ['party', 'session', sessionId] });
      qc.invalidateQueries({ queryKey: ['party', 'sessions', 'by-project'] });
    },
  });
}
