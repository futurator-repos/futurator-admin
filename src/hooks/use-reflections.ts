'use client';
/**
 * use-reflections.ts — Pipeline v2 Phase 3 / Story 3-E-3-1 (PR-76).
 *
 * TanStack Query hooks for the Reflection Inbox. Mirrors `use-attention-items`
 * conventions: 30s polling, optimistic mutations, single shared cache key.
 */

import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api-client';
import type {
  ReflectionItem,
  ReflectionStatus,
  ReflectionDecision,
} from '../../functions/shared/types/reflection';

export interface ReflectionListResponse {
  items: ReflectionItem[];
  pendingCount: number;
  total: number;
}

/**
 * List reflections — optionally filtered by `projectSlug` and / or
 * `status`. Polls every 30s by default; consumers wanting a one-shot
 * pass `staleTime: Infinity`.
 */
export function useReflections(
  args: {
    projectSlug?: string;
    status?: ReflectionStatus;
  } = {},
) {
  const params = new URLSearchParams();
  if (args.projectSlug) params.set('projectSlug', args.projectSlug);
  if (args.status) params.set('status', args.status);
  const qs = params.toString();
  const url = qs ? `/api/reflections?${qs}` : '/api/reflections';

  return useQuery({
    queryKey: ['reflections', args.projectSlug ?? null, args.status ?? null],
    queryFn: () => api.get<ReflectionListResponse>(url),
    refetchInterval: 30_000,
  });
}

export function useReflectionDecision() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (args: { projectSlug: string; id: string; decision: ReflectionDecision }) => {
      const url = `/api/reflections/${encodeURIComponent(args.projectSlug)}/${encodeURIComponent(args.id)}/${args.decision}`;
      return api.post<{ item: ReflectionItem }>(url, {});
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['reflections'] });
    },
  });
}
