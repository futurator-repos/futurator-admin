'use client';
import { useQuery, useQueries, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api-client';
import type { AgentJob, CreateAgentJobInput } from '@/types/agent-orchestrator';

export function useAgentJob(jobId: string | null) {
  return useQuery({
    queryKey: ['agent-job', jobId],
    queryFn: () => api.get<AgentJob>(`/agent-jobs/${jobId}`),
    enabled: !!jobId,
    retry: (failureCount, error) => {
      // Don't retry 404s (deleted jobs)
      if (error instanceof Error && error.message.includes('not found')) return false;
      return failureCount < 2;
    },
    refetchInterval: (query) => {
      // Stop polling on error (e.g., 404 for deleted jobs)
      if (query.state.error) return false;
      const status = query.state.data?.status;
      if (!status) return 2000;
      if (status === 'COMPLETED' || status === 'FAILED') return false;
      return 1000;
    },
    // I8 UI defect #1 — keep polling while the operator has this tab/pane
    // backgrounded (e.g. watching another stage subtab), so the phase stepper
    // isn't stale when they switch back.
    refetchIntervalInBackground: true,
  });
}

export function useAgentJobs(jobIds: string[], hasRunning?: boolean) {
  return useQueries({
    queries: jobIds.map((jobId) => ({
      queryKey: ['agent-job', jobId],
      queryFn: () => api.get<AgentJob>(`/agent-jobs/${jobId}`),
      enabled: !!jobId,
      staleTime: hasRunning ? 2_000 : 30_000,
      retry: (failureCount: number, error: Error) => {
        if (error instanceof Error && error.message.includes('not found')) return false;
        return failureCount < 2;
      },
      refetchInterval: (query: { state: { error: Error | null; data?: AgentJob } }) => {
        if (query.state.error) return false;
        if (!hasRunning) return false;
        const status = query.state.data?.status;
        if (status === 'COMPLETED' || status === 'FAILED') return false;
        return 3_000;
      },
    })),
  });
}

export function useCreateAgentJob() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (input: CreateAgentJobInput) => {
      console.log('[Labs] Creating job:', {
        workingDir: input.workingDir,
        steps: input.pipeline.steps.length,
      });
      return api.post<{ jobId: string; status: string }>('/agent-jobs', input);
    },
    onSuccess: (data) => {
      console.log('[Labs] Job created:', data);
      queryClient.invalidateQueries({ queryKey: ['agent-job'] });
    },
    onError: (err) => {
      console.error('[Labs] Job creation failed:', err);
    },
  });
}
