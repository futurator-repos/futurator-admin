'use client';
import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api-client';
import { resolveRepoRef } from '../../functions/shared/github/parse-repo-url';
import type { GitHubRepo, RateLimit } from '../../functions/shared/github/types';

export interface GithubRepoSummaryResponse {
  repo: GitHubRepo;
  rateLimit: RateLimit;
}

/**
 * Story 1.5.1 — fetch a single futurator-repos GitHub repo's metadata.
 *
 * Calls GET /api/github/repos/futurator-repos/:appId (auth-required).
 * 5-min staleTime matches project default.
 *
 * 404 → `data` is undefined, `is404` is true — caller should hide or show
 * a "no repo yet" note rather than an error state.
 */
export function useGithubRepoSummary(
  appId: string | null | undefined,
  githubRepoUrl?: string | null,
) {
  const { owner, repo } = resolveRepoRef(appId ?? '', githubRepoUrl);
  return useQuery({
    queryKey: ['github-repo', owner, repo],
    queryFn: () => api.get<GithubRepoSummaryResponse>(`/github/repos/${owner}/${repo}`),
    enabled: !!appId,
    staleTime: 5 * 60 * 1000,
    retry: (failureCount, error) => {
      // Do not retry 404s — repo simply doesn't exist yet (pre-1.4 app).
      const err = error as Error & { status?: number };
      if (err.status === 404) return false;
      return failureCount < 2;
    },
  });
}
