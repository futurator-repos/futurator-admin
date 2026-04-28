'use client';
import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api-client';
import type { TreeEntry, RateLimit } from '../../functions/shared/github/types';

export interface GithubTreeResponse {
  tree: TreeEntry[];
  truncated: boolean;
  count: number;
  rateLimit: RateLimit;
}

/**
 * Story 1.5.2 — fetch the recursive file tree for a futurator-repos GitHub repo.
 *
 * Calls GET /api/github/repos/futurator-repos/:appId/tree?branch=<branch>
 * (auth-required). 5-min staleTime.
 *
 * `branch` is optional — the API resolves to the repo's default branch when
 * omitted, but callers should pass it to avoid an extra round-trip inside the
 * connector.
 */
export function useGithubTree(appId: string | null | undefined, branch: string | null | undefined) {
  const qs = branch ? `?branch=${encodeURIComponent(branch)}` : '';
  return useQuery({
    queryKey: ['github-tree', 'futurator-repos', appId, branch ?? 'default'],
    queryFn: () => api.get<GithubTreeResponse>(`/github/repos/futurator-repos/${appId}/tree${qs}`),
    enabled: !!appId,
    staleTime: 5 * 60 * 1000,
    retry: (failureCount, error) => {
      const err = error as Error & { status?: number };
      if (err.status === 404) return false;
      return failureCount < 2;
    },
  });
}
