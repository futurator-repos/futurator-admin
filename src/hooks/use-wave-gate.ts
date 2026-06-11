'use client';
/**
 * pacman1 (2026-06-11) — wave gate (merge + build-check) operator actions.
 *
 * A failed wave gate used to be a dead end: the wave-reducer only
 * auto-retries TRANSIENT failures, so a real build failure halted the epic
 * in 'fixing' with no UI affordance ("Retry step" was advertised on the
 * attention card but never rendered). This mutation backs the Retry button
 * in both the hierarchy wave row and the attention cards.
 */
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api-client';

export interface RetryWaveGateInput {
  planId: string;
  epicId: string;
  waveNumber: number;
}

export interface RetryWaveGateResponse {
  jobId: string;
  waveNumber: number;
  storyIds: string[];
}

export function useRetryWaveGate() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ planId, epicId, waveNumber }: RetryWaveGateInput) =>
      api.post<RetryWaveGateResponse>(`/plans/${planId}/waves/retry-gate`, {
        epicId,
        waveNumber,
      }),
    onSuccess: (_data, vars) => {
      // The epic's waveBuildJobs pointer changed → refetch the plan tree
      // (which hydrates epics) and any attention rollups referencing it.
      queryClient.invalidateQueries({ queryKey: ['plans', vars.planId] });
      queryClient.invalidateQueries({ queryKey: ['epic-workflow', vars.epicId] });
      queryClient.invalidateQueries({ queryKey: ['attention'] });
      queryClient.invalidateQueries({ queryKey: ['attention-items', vars.planId] });
    },
  });
}
