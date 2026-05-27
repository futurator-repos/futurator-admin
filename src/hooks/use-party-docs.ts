'use client';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api-client';

/**
 * Doc scope. `session` docs are private to a single debate; `shared` docs are
 * project-level knowledge visible in every debate. See the backend doc routes
 * (functions/api/index.ts) for the S3 key layout.
 */
export type DocScope = 'session' | 'shared';

export interface PartyDoc {
  filename: string;
  s3Key: string;
  size: number;
  uploadedAt: string | null;
  scope: DocScope;
}

interface ListResponse {
  projectId: string;
  sessionId: string | null;
  shared: PartyDoc[];
  session: PartyDoc[];
}

interface UploadUrlResponse {
  uploadUrl: string;
  s3Bucket: string;
  s3Key: string;
  filename: string;
  scope: DocScope;
}

/**
 * List the docs visible in a debate: the project's `shared` docs always, plus
 * this `session`'s private docs when a sessionId is supplied. Returns both
 * lists separately so the tray can label them.
 */
export function usePartyDocs(projectId: string | null, sessionId: string | null) {
  return useQuery({
    queryKey: ['party', 'docs', projectId, sessionId],
    queryFn: () => {
      const qs = sessionId ? `?sessionId=${encodeURIComponent(sessionId)}` : '';
      return api.get<ListResponse>(`/party/projects/${projectId}/docs${qs}`);
    },
    enabled: !!projectId,
    staleTime: 10_000,
  });
}

/**
 * Upload a single file. Flow: (1) ask the API for a presigned PUT URL scoped
 * to `session` (default) or `shared`, (2) PUT the bytes directly to S3,
 * (3) confirm via /synced. The daemon mirrors S3 → the worktree's
 * `.party-uploads/` at the start of the next turn, so no copy job is needed.
 */
export function useUploadPartyDoc(projectId: string | null, sessionId: string | null) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ file, scope = 'session' }: { file: File; scope?: DocScope }) => {
      if (!projectId) throw new Error('projectId is required');
      if (scope === 'session' && !sessionId) {
        throw new Error('sessionId is required for a session-scoped upload');
      }
      const contentType = file.type || 'application/octet-stream';
      const sessionIdForScope = scope === 'session' ? sessionId : undefined;
      const urlResp = await api.post<UploadUrlResponse>(
        `/party/projects/${projectId}/docs/upload-url`,
        { filename: file.name, contentType, scope, sessionId: sessionIdForScope },
      );
      const res = await fetch(urlResp.uploadUrl, {
        method: 'PUT',
        body: file,
        headers: { 'Content-Type': contentType },
      });
      if (!res.ok) {
        throw new Error(`S3 upload failed: ${res.status} ${res.statusText}`);
      }
      await api.post(`/party/projects/${projectId}/docs/synced`, {
        filename: urlResp.filename,
        s3Key: urlResp.s3Key,
        scope,
        sessionId: sessionIdForScope,
      });
      return { filename: urlResp.filename, scope };
    },
    // Invalidate the whole project's doc queries (any sessionId) so a shared
    // upload refreshes the active session's tray too.
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['party', 'docs', projectId] });
    },
  });
}

export function useDeletePartyDoc(projectId: string | null, sessionId: string | null) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ filename, scope }: { filename: string; scope: DocScope }) => {
      if (!projectId) throw new Error('projectId is required');
      const params = new URLSearchParams({ scope });
      if (scope === 'session') {
        if (!sessionId) throw new Error('sessionId is required to delete a session-scoped doc');
        params.set('sessionId', sessionId);
      }
      return api.delete<{ projectId: string; filename: string; scope: DocScope }>(
        `/party/projects/${projectId}/docs/${encodeURIComponent(filename)}?${params.toString()}`,
      );
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['party', 'docs', projectId] });
    },
  });
}

export function useCreatePartyProject() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (projectId: string) =>
      api.post<{ jobId: string; projectId: string; projectPath: string }>('/party/projects', {
        projectId,
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['party', 'projects'] });
    },
  });
}
