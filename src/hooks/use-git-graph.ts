'use client';
import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api-client';
import type {
  GitHubBranch,
  GitHubCommit,
  GitHubPullRequest,
  RateLimit,
} from '../../functions/shared/github/types';

export interface GitGraphRepoSummary {
  name: string;
  full_name: string;
  description: string | null;
  default_branch: string;
  html_url: string;
}

export interface GitGraphResponse {
  repo: GitGraphRepoSummary;
  commits: GitHubCommit[];
  branches: GitHubBranch[];
  pullRequests: GitHubPullRequest[];
  rateLimit: RateLimit;
}

const GITHUB_OWNER = 'futurator-repos';

/**
 * Fetch the bundled git-graph payload for a futurator-repos repo. Wraps
 * GET /api/github/repos/futurator-repos/:appId/git-graph.
 *
 * 404 → likely a pre-Apps plan whose working dir was never paired with a
 * GitHub repo. The view should render an empty state, not error UI.
 */
export function useGitGraph(appId: string | null | undefined) {
  return useQuery({
    queryKey: ['git-graph', GITHUB_OWNER, appId],
    queryFn: () => api.get<GitGraphResponse>(`/github/repos/${GITHUB_OWNER}/${appId}/git-graph`),
    enabled: !!appId,
    staleTime: 60_000,
    retry: (failureCount, error) => {
      const err = error as Error & { status?: number };
      if (err.status === 404) return false;
      return failureCount < 2;
    },
  });
}
