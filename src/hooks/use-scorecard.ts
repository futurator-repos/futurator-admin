'use client';

/**
 * Plan Retrospect hooks (spec §7).
 *
 *   useScorecard(planId)          — GET /plans/:id/scorecard → the Reality Check.
 *   useRunScorecardStage(planId)  — POST /plans/:id/scorecard/:stage/run.
 *
 * NOTE: the api-client base URL already ends in `/api` (MEMORY:
 * project_api_client_path_convention) — do NOT prefix paths with `/api` here or
 * you get `/api/api/...` → 404. Internal route segment `/scorecard/` is fine in
 * a network call (spec §1); it is never rendered as UI copy.
 *
 * 5-min staleTime, matching sibling plan hooks (use-plan-timing etc.).
 */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api-client';
import type { RealityCheck, RunScorecardStageResponse, StageId } from '@/types/scorecard';

const QK_SCORECARD = (planId: string) => ['plan-scorecard', planId] as const;
const STALE_MS = 5 * 60 * 1000;

/** The full Reality Check for a plan (all stored stage slices + rollup + actions). */
export function useScorecard(planId: string | null) {
  return useQuery({
    queryKey: QK_SCORECARD(planId ?? ''),
    queryFn: () => api.get<RealityCheck>(`/plans/${planId}/scorecard`),
    enabled: !!planId,
    staleTime: STALE_MS,
  });
}

/**
 * `:stage ∈ {concept, development, qa, deployment, publish, overview}` or
 * `'all'`. Deterministic-only stages resolve inline (`status:'scored'`);
 * `[LLM]` stages return `status:'assessing'` + a `jobId` to stream.
 *
 * Invalidates the plan's Reality Check on success so the rail/cards refresh.
 */
export function useRunScorecardStage(planId: string | null) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (stage: StageId | 'all') =>
      api.post<RunScorecardStageResponse>(`/plans/${planId}/scorecard/${stage}/run`, {}),
    onSuccess: () => {
      if (planId) qc.invalidateQueries({ queryKey: QK_SCORECARD(planId) });
    },
  });
}
