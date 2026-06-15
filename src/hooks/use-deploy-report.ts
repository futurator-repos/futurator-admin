'use client';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api-client';
import type { DeployReport } from '@/types/deploy-report';

/**
 * Fetch the plan-wide Deploy report. Polls aggressively while a deploy or any
 * environment promotion is running; slows to 20s when stable so the history
 * view doesn't hammer the API unnecessarily.
 */
export function useDeployReport(planId: string | null) {
  return useQuery({
    queryKey: ['deploy-report', planId],
    queryFn: () => api.get<DeployReport>(`/plans/${planId}/deploy-report`),
    enabled: !!planId,
    staleTime: 3_000,
    refetchInterval: (query) => {
      const r = query.state.data;
      if (!r) return 5_000;
      if (r.verdict === 'deploying') return 3_000;
      // Deployment v2.5 — keep polling while any rung is mid-promotion.
      if (r.environments?.some((e) => e.status === 'deploying')) return 3_000;
      return 20_000;
    },
  });
}

/**
 * Deployment v2.5 — promote the built artifact up the ladder.
 *   to: 'staging'    → dev build → staging
 *   to: 'production' → staging   → production (delivery; advances main)
 */
export function usePromoteApp(planId: string | null) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (to: 'staging' | 'production') =>
      api.post<{ jobId: string; to: string; publicUrl: string }>(`/plans/${planId}/promote`, {
        to,
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['deploy-report', planId] });
      qc.invalidateQueries({ queryKey: ['qa-report', planId] });
    },
  });
}

/** Deployment v2.5 — roll production back to a previously-archived release. */
export function useRollback(planId: string | null) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (jobId: string) =>
      api.post<{ jobId: string; rolledBackTo: string; publicUrl: string }>(
        `/plans/${planId}/rollback`,
        { jobId },
      ),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['deploy-report', planId] }),
  });
}
