/**
 * use-ultracode-scorecard.ts — read the scored result once a run reaches a terminal state.
 * Returns null while the run is still in flight (the panel shows "awaiting halt / daemon").
 */

'use client';

import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api-client';
import type { UltracodeRunStatus, UltracodeScorecard } from '@/types/ultracode-run';

export interface ScorecardResponse {
  status: UltracodeRunStatus;
  scorecard: UltracodeScorecard | null;
  structuralScore?: number;
  guardrailUplift?: number;
  verdict?: string;
  confound?: string;
}

export function useUltracodeScorecard(runId: string | null, enabled: boolean) {
  return useQuery<ScorecardResponse>({
    queryKey: ['ultracode-scorecard', runId],
    queryFn: () => api.get<ScorecardResponse>(`/ultracode/runs/${runId}/scorecard`),
    enabled: !!runId && enabled,
    staleTime: 5 * 60 * 1000,
  });
}
