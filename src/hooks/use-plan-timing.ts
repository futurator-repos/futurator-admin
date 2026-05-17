'use client';

/**
 * Story 1.8.4 — Plan timing hook.
 *
 * Fetches GET /api/plans/:planId/timing and drives live 5s polling when
 * data.isLive === true.
 *
 * Client-side "lastSeq" efficiency note (Phase-2 enhancement):
 *   Currently, every 5-second refetch re-renders consumers regardless of
 *   whether the slice count changed. The `sliceCountUnchanged` value returned
 *   by this hook enables callers to skip expensive derived-state computations
 *   when the data hasn't grown.
 *
 *   Phase-2 enhancement: add `If-Modified-Since: <latest-slice-startedAt>`
 *   header so the server can return 304 Not Modified and skip serialisation
 *   entirely. On the client side, compare `data.slices.length` to the previous
 *   fetch's count via a stable reference passed through a TanStack Query
 *   `select` transform, which avoids hooks-rule violations.
 */

import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api-client';
import type { TimerSlice, TimerCategory } from '../../functions/shared/timer/types';

export interface PlanTimingAggregate {
  byCategory: Partial<Record<TimerCategory, { totalMs: number; count: number }>>;
  totalMs: number;
}

export interface PlanTimingData {
  planId: string;
  slices: TimerSlice[];
  aggregate: PlanTimingAggregate;
  planTotalMs: number;
  isLive: boolean;
}

export function usePlanTiming(planId: string | null) {
  const query = useQuery({
    queryKey: ['plan-timing', planId],
    queryFn: () => api.get<PlanTimingData>(`/plans/${planId}/timing`),
    enabled: !!planId,
    staleTime: 5 * 60 * 1000,
    refetchInterval: (q) => {
      // 2026-05-17 dino-7: previously gated on `data.isLive`, which froze
      // the panel at "00:00" forever when the first poll landed before any
      // job had emitted events (slices=[], isLive=false → polling stopped,
      // never restarted as jobs spun up). Now we keep polling whenever
      // there's no data, or data shows we haven't seen the first slice yet,
      // or data shows live work — and only stop when we have a terminal
      // payload (slices present, none live).
      if (q.state.error) return false;
      const data = q.state.data;
      if (!data) return 30_000;
      if (data.isLive) return 60_000;
      if (data.slices.length === 0) return 30_000;
      return false;
    },
  });

  return {
    ...query,
    /**
     * Optimistic hint: true when the current slice count matches the previous
     * TanStack Query dataUpdatedAt snapshot, indicating no new slices arrived.
     * Callers can skip expensive derived-state recomputation when this is true.
     *
     * Phase-2 TO-DO: implement properly via a `select` transform that compares
     * the new slice array length to the stashed previous length — avoiding any
     * hooks-rule violations while still enabling the optimisation.
     */
    sliceCountUnchanged: false as boolean,
  };
}
