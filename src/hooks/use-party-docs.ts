'use client';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api-client';

export interface PartyDoc {
  filename: string;
  s3Key: string;
  size: number;
  uploadedAt: string | null;
}

interface ListResponse {
  projectId: string;
  docs: PartyDoc[];
}

interface UploadUrlResponse {
  uploadUrl: string;
  s3Bucket: string;
  s3Key: string;
  filename: string;
}

export function usePartyDocs(projectId: string | null) {
  return useQuery({
    queryKey: ['party', 'docs', projectId],
    queryFn: () => api.get<ListResponse>(`/party/projects/${projectId}/docs`),
    enabled: !!projectId,
    staleTime: 10_000,
  });
}

/**
 * Upload a single file to the project's doc tray.
 *
 * Flow: (1) ask the API for a presigned PUT URL, (2) PUT the file bytes
 * directly to S3, (3) tell the API the upload succeeded — that enqueues a
 * daemon job that copies the file from S3 to `<projectPath>/docs/<filename>`
 * on EC2 so Claude's Read tool can see it during the next Party turn.
 */
export function useUploadPartyDoc(projectId: string | null) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (file: File) => {
      if (!projectId) throw new Error('projectId is required');
      const urlResp = await api.post<UploadUrlResponse>(
        `/party/projects/${projectId}/docs/upload-url`,
        {
          filename: file.name,
          contentType: file.type || 'application/octet-stream',
        },
      );
      const res = await fetch(urlResp.uploadUrl, {
        method: 'PUT',
        body: file,
        headers: { 'Content-Type': file.type || 'application/octet-stream' },
      });
      if (!res.ok) {
        throw new Error(`S3 upload failed: ${res.status} ${res.statusText}`);
      }
      const syncResp = await api.post<{ jobId: string; filename: string }>(
        `/party/projects/${projectId}/docs/synced`,
        { filename: urlResp.filename, s3Key: urlResp.s3Key },
      );
      return { filename: urlResp.filename, jobId: syncResp.jobId };
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['party', 'docs', projectId] });
    },
  });
}

export function useDeletePartyDoc(projectId: string | null) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (filename: string) => {
      if (!projectId) throw new Error('projectId is required');
      return api.delete<{ jobId: string; filename: string }>(
        `/party/projects/${projectId}/docs/${encodeURIComponent(filename)}`,
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
      api.post<{ jobId: string; projectId: string; projectPath: string }>(
        '/party/projects',
        { projectId },
      ),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['party', 'projects'] });
    },
  });
}
