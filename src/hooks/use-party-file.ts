'use client';
import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api-client';

export interface PartyFileResponse {
  /** Path relative to projectPath. */
  path: string;
  /** Absolute path on EC2 (`/home/ubuntu/projects/<id>/<path>`). */
  fullPath: string;
  /** File size in bytes. */
  size: number;
  /** Sniffed by extension. */
  contentType: 'text/markdown' | 'application/json' | 'text/html' | 'text/plain';
  /** UTF-8 file content. Capped at 1 MiB by the API. */
  content: string;
}

/**
 * Read one file from a Party project's working directory on EC2. Used by
 * the file-preview drawer in the chat. Backed by SSM with strong path-
 * traversal protection — see api/index.ts /api/party/projects/:projectId/files.
 */
export function usePartyFile(projectId: string | null, path: string | null) {
  return useQuery({
    queryKey: ['party-file', projectId, path],
    queryFn: () =>
      api.get<PartyFileResponse>(
        `/party/projects/${projectId}/files?path=${encodeURIComponent(path!)}`,
      ),
    enabled: !!projectId && !!path,
    staleTime: 30_000,
    retry: (failureCount, error) => {
      const msg = error instanceof Error ? error.message : String(error);
      // Don't retry path-not-found / forbidden / too-large — they're user
      // errors that won't fix themselves.
      if (/\b(404|403|413)\b|not.?found|forbidden|too.?large/i.test(msg)) return false;
      return failureCount < 1;
    },
  });
}
