'use client';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api-client';
import type { AttentionItem } from '../../functions/shared/types/attention';

/**
 * Pipeline v1 — Story 1.10. Cross-plan attention inbox.
 * Backed by GET /api/attention which fans out across every plan and merges.
 */

export interface GlobalAttentionItem extends AttentionItem {
  /** Set by the API when aggregating across plans so the inbox can label rows. */
  planName?: string;
}

interface GlobalAttentionResponse {
  items: GlobalAttentionItem[];
  unresolvedCount: number;
  total: number;
}

export function useGlobalAttention(opts?: { status?: 'open' | 'all' }) {
  const status = opts?.status ?? 'open';
  return useQuery({
    queryKey: ['attention', 'global', status],
    queryFn: () => api.get<GlobalAttentionResponse>(`/attention?status=${status}`),
    refetchInterval: 30_000,
    staleTime: 5_000,
  });
}

export function useResolveGlobalAttention() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ planId, itemId }: { planId: string; itemId: string }) =>
      api.post<{ item: AttentionItem }>(`/plans/${planId}/attention-items/${itemId}/resolve`, {}),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['attention'] });
      queryClient.invalidateQueries({ queryKey: ['attention-items'] });
    },
  });
}

/**
 * PR-9 #4 — bulk-resolve every open attention item for a plan. Bell drawer
 * uses this to let the operator clear pre-PR-7 noise (or any plan whose
 * failures are no longer actionable) without per-row clicks.
 */
export function useResolveAllForPlan() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (planId: string) =>
      api.post<{ planId: string; resolvedCount: number }>(
        `/plans/${planId}/attention-items/resolve-all`,
        {},
      ),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['attention'] });
      queryClient.invalidateQueries({ queryKey: ['attention-items'] });
    },
  });
}
