'use client';
import { useQuery, type UseQueryResult } from '@tanstack/react-query';
import { api } from '@/lib/api-client';
import type {
  DistilledInstinct,
  GateBlockEvent,
  InstinctFeed,
  InstinctObservation,
  PromotedInstinct,
} from '@/types/plan-spec';

export type {
  DistilledInstinct,
  GateBlockEvent,
  InstinctFeed,
  InstinctObservation,
  PromotedInstinct,
};

/**
 * The instinct-loop feed for a plan (GET /plans/:id/instincts): raw
 * observations, distilled + promoted instincts, and live-gate would-blocks.
 * Greenfield read — the backend returns empty arrays until a durable source is
 * wired, so the Skills & Learnings panel always renders. Polled at 30s (slow,
 * learning-loop cadence — this is not a hot path).
 */
export function useInstincts(planId: string | null): UseQueryResult<InstinctFeed> {
  return useQuery({
    queryKey: ['instincts', planId],
    queryFn: () => api.get<InstinctFeed>(`/plans/${planId}/instincts`),
    enabled: !!planId,
    refetchInterval: 30_000,
  });
}
