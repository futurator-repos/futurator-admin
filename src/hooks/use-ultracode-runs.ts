/**
 * use-ultracode-runs.ts — the bench corpus list (operator-scoped, newest first).
 *
 * Polls while any run is non-terminal so the corpus badges (queued → capturing → scoring →
 * complete) update live without a manual refresh. Also exposes a delete mutation so the operator
 * can dismiss errored/old runs.
 */

'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api-client';
import { ACTIVE_STATUSES, type UltracodeRunSummary } from '@/types/ultracode-run';

interface RunsResponse {
  runs: UltracodeRunSummary[];
}

const POLL_INTERVAL_MS = 2000;

export function useUltracodeRuns() {
  return useQuery<RunsResponse>({
    queryKey: ['ultracode-runs'],
    queryFn: () => api.get<RunsResponse>('/ultracode/runs'),
    staleTime: 0,
    // Keep the corpus live while any run is still working; otherwise stop polling.
    refetchInterval: (q) => {
      const data = q.state.data as RunsResponse | undefined;
      const anyActive = (data?.runs ?? []).some((r) => ACTIVE_STATUSES.has(r.status));
      return anyActive ? POLL_INTERVAL_MS : false;
    },
  });
}

export function useDeleteUltracodeRun() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (runId: string) => api.delete<{ ok: boolean }>(`/ultracode/runs/${runId}`),
    // Optimistic: drop the row immediately so the card disappears on click.
    onMutate: async (runId: string) => {
      await queryClient.cancelQueries({ queryKey: ['ultracode-runs'] });
      const prev = queryClient.getQueryData<RunsResponse>(['ultracode-runs']);
      queryClient.setQueryData<RunsResponse>(['ultracode-runs'], (old) =>
        old ? { runs: old.runs.filter((r) => r.runId !== runId) } : old,
      );
      return { prev };
    },
    onError: (_e, _runId, ctx) => {
      if (ctx?.prev) queryClient.setQueryData(['ultracode-runs'], ctx.prev);
    },
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: ['ultracode-runs'] });
    },
  });
}
