'use client';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api-client';
import type { AgentJob } from '@/types/agent-orchestrator';

/**
 * Pipeline v1 — Stories 1.5–1.8. Operator actions on a NEEDS_ATTENTION job.
 * All four hooks invalidate `['plans']` + `['attention']` so the UI refreshes
 * the failed-step panel and inbox after a successful action.
 */

interface SalvageResult {
  ok: true;
  job: AgentJob;
  advanced: boolean;
}

interface RetryResult {
  ok: true;
  newJobId: string;
}

interface SkipResult {
  ok: true;
  advanced: boolean;
}

interface AbortResult {
  ok: true;
}

function invalidateAfterAction(queryClient: ReturnType<typeof useQueryClient>) {
  queryClient.invalidateQueries({ queryKey: ['plans'] });
  queryClient.invalidateQueries({ queryKey: ['attention'] });
  queryClient.invalidateQueries({ queryKey: ['attention-items'] });
}

export function useSalvageStep() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ jobId, stepId }: { jobId: string; stepId: string }) =>
      api.post<SalvageResult>(`/jobs/${jobId}/steps/${stepId}/salvage`, {}),
    onSuccess: () => invalidateAfterAction(queryClient),
  });
}

export function useRetryStep() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ jobId, stepId, hint }: { jobId: string; stepId: string; hint?: string }) =>
      api.post<RetryResult>(`/jobs/${jobId}/steps/${stepId}/retry`, { hint }),
    onSuccess: () => invalidateAfterAction(queryClient),
  });
}

export function useSkipStep() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ jobId, stepId, reason }: { jobId: string; stepId: string; reason?: string }) =>
      api.post<SkipResult>(`/jobs/${jobId}/steps/${stepId}/skip`, { reason }),
    onSuccess: () => invalidateAfterAction(queryClient),
  });
}

export function useAbortStep() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ jobId, stepId, reason }: { jobId: string; stepId: string; reason?: string }) =>
      api.post<AbortResult>(`/jobs/${jobId}/steps/${stepId}/abort`, { reason }),
    onSuccess: () => invalidateAfterAction(queryClient),
  });
}
