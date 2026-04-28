'use client';

/**
 * Story 1.8.5 — Cohort hook.
 *
 * Fetches GET /api/timing/cohort?templateType=&planKind=&epicCount=
 *
 * Key design decisions:
 * - Returns null (not an error) when the API 404s (< 5 samples).
 *   Callers render the "Cohort baseline accumulating" pill instead of an error.
 * - staleTime is 30 minutes — cohort baselines are expensive to compute and
 *   only change when the cron runs (Story 1.8.6, every 6h). Aggressive caching
 *   prevents duplicate requests for the same (templateType, planKind, epicCount)
 *   tuple across all Performance tab rows.
 * - The query key encodes the tuple so TanStack Query dedupes across the N plan
 *   rows that share the same cohort parameters.
 * - App.boilerplateType may be absent for legacy apps — default to 'nextjs'.
 */

import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api-client';
import type { TimerCategory } from '../../functions/shared/timer/types';

export type BoilerplateType = 'nextjs' | 'sst' | 'vite' | 'mobile';
export type PlanKind = 'initial' | 'change' | 'experiment';

export interface CohortData {
  samples: number;
  medianMs: number;
  p90Ms: number;
  byCategory: Partial<Record<TimerCategory, { medianMs: number; p90Ms: number }>>;
}

export interface UseCohortParams {
  templateType: BoilerplateType;
  planKind: PlanKind;
  epicCount: number;
}

/** Sentinel: cohort has < 5 samples. Render "accumulating" pill. */
export const COHORT_ACCUMULATING = 'accumulating' as const;
export type CohortResult = CohortData | typeof COHORT_ACCUMULATING | null;

export function useCohort({ templateType, planKind, epicCount }: UseCohortParams) {
  return useQuery({
    queryKey: ['cohort', templateType, planKind, epicCount],
    queryFn: async (): Promise<CohortResult> => {
      try {
        return await api.get<CohortData>(
          `/timing/cohort?templateType=${templateType}&planKind=${planKind}&epicCount=${epicCount}`,
        );
      } catch (err) {
        const status = (err as { status?: number }).status;
        if (status === 404) {
          // Insufficient samples — not an error state, just "accumulating".
          return COHORT_ACCUMULATING;
        }
        throw err;
      }
    },
    // Aggressive caching: cohort data is stable between cron runs (every 6h).
    staleTime: 30 * 60 * 1000,
    retry: (failureCount, err) => {
      const status = (err as { status?: number }).status;
      if (status === 404) return false; // handled above — never retry 404
      return failureCount < 2;
    },
  });
}
