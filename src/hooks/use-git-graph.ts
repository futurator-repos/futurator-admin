'use client';
import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api-client';
import { resolveRepoRef } from '../../functions/shared/github/parse-repo-url';
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

/**
 * Fetch the bundled git-graph payload. Resolves the repo from the App's
 * `githubRepoUrl` (brownfield, any org) when provided, else falls back to
 * `futurator-repos/<appId>` (greenfield convention).
 *
 * 404 → no GitHub repo paired (greenfield without a repo); the API serves a
 * bare-repo snapshot fallback, and if that's also absent the view renders an
 * empty state, not error UI.
 */
export function useGitGraph(appId: string | null | undefined, githubRepoUrl?: string | null) {
  const { owner, repo } = resolveRepoRef(appId ?? '', githubRepoUrl);
  return useQuery({
    queryKey: ['git-graph', owner, repo],
    queryFn: () => api.get<GitGraphResponse>(`/github/repos/${owner}/${repo}/git-graph`),
    enabled: !!appId,
    staleTime: 60_000,
    retry: (failureCount, error) => {
      const err = error as Error & { status?: number };
      if (err.status === 404) return false;
      return failureCount < 2;
    },
  });
}
