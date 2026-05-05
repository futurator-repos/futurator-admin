'use client';
import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api-client';
import type { DeployReport } from '@/types/deploy-report';

/**
 * Fetch the plan-wide Deploy report. Polls aggressively while a deploy is
 * running; slows to 20s when stable so the history view doesn't hammer the
 * API unnecessarily.
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
      return 20_000;
    },
  });
}
