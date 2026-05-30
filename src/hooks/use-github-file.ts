'use client';
import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api-client';
import { resolveRepoRef } from '../../functions/shared/github/parse-repo-url';
import type { RateLimit } from '../../functions/shared/github/types';

export type GithubFileResponse =
  | { content: string; encoding: 'utf-8'; sha: string; size: number; rateLimit: RateLimit }
  | { tooLarge: true; size: number; rateLimit: RateLimit };

/**
 * Story 1.5.2 — fetch the content of a single file from a futurator-repos repo.
 *
 * Calls GET /api/github/repos/futurator-repos/:appId/files?path=<path>&ref=<ref>
 * (auth-required). 5-min staleTime.
 *
 * Files > 1MB: API returns `{ tooLarge: true, size }` — component must show
 * a "Too large to preview" placeholder.
 */
export function useGithubFile(
  appId: string | null | undefined,
  filePath: string | null | undefined,
  ref?: string,
  githubRepoUrl?: string | null,
) {
  const qs = new URLSearchParams();
  if (filePath) qs.set('path', filePath);
  if (ref) qs.set('ref', ref);
  const { owner, repo } = resolveRepoRef(appId ?? '', githubRepoUrl);

  return useQuery({
    queryKey: ['github-file', owner, repo, filePath ?? '', ref ?? ''],
    queryFn: () =>
      api.get<GithubFileResponse>(`/github/repos/${owner}/${repo}/files?${qs.toString()}`),
    enabled: !!appId && !!filePath,
    staleTime: 5 * 60 * 1000,
    retry: (failureCount, error) => {
      const err = error as Error & { status?: number };
      if (err.status === 404) return false;
      return failureCount < 2;
    },
  });
}
