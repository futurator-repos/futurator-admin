'use client';

/**
 * Story 1.8.5 — App timing hook.
 *
 * Fetches GET /api/apps/:appId/timing.
 * Returns recentPlans (last 20 delivered plans) + appAggregate.
 * staleTime is kept high because this data only changes when a new plan
 * is delivered — callers should invalidate when a plan transitions to
 * 'delivered'.
 */

import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api-client';
import type { TimerCategory } from '../../functions/shared/timer/types';

export interface PlanTimingSummary {
  planId: string;
  planLabel?: string;
  startedAt: string;
  endedAt: string;
  durationMs: number;
  byCategory: Partial<Record<TimerCategory, number>>;
}

export interface AppTimingAggregate {
  byCategory: Partial<Record<TimerCategory, number>>;
  totalMs: number;
}

export interface AppTimingData {
  appId: string;
  recentPlans: PlanTimingSummary[];
  appAggregate: AppTimingAggregate;
}

export function useAppTiming(appId: string | null | undefined) {
  return useQuery({
    queryKey: ['app-timing', appId],
    queryFn: () => api.get<AppTimingData>(`/apps/${appId}/timing`),
    enabled: !!appId,
    // Timing data only changes when a new plan is delivered — no need for
    // aggressive polling; invalidate from mutation on plan delivery instead.
    staleTime: 5 * 60 * 1000,
    retry: (failureCount, error) => {
      const msg = error instanceof Error ? error.message : String(error);
      if (/\b404\b|not.?found/i.test(msg)) return false;
      return failureCount < 2;
    },
  });
}
