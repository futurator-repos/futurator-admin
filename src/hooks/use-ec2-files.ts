'use client';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api-client';

export interface FileEntry {
  name: string;
  type: 'file' | 'directory';
  size: number;
  permissions: string;
  modified: string;
}

interface FilesResponse {
  path: string;
  entries: FileEntry[];
}

export function useEc2Files(path: string, enabled: boolean) {
  return useQuery({
    queryKey: ['ec2-files', path],
    queryFn: () => api.get<FilesResponse>(`/ec2/files?path=${encodeURIComponent(path)}`),
    enabled,
    staleTime: 30_000,
  });
}

// Backend wire format for /api/ec2/files/content. `kind` drives the renderer:
// text → CodeMirror / markdown / plain; image → <img> data URL; pdf → <embed>;
// binary → download-only fallback. `tooLarge` short-circuits everything above
// the 2 MB cap so we don't blow the browser memory.
export type FileContentResponse =
  | { kind: 'text'; mime: string; size: number; mtime: number; content: string }
  | { kind: 'image'; mime: string; size: number; mtime: number; base64: string }
  | { kind: 'pdf'; mime: string; size: number; mtime: number; base64: string }
  | { kind: 'binary'; mime: string; size: number; mtime: number; base64: string }
  | {
      tooLarge: true;
      size: number;
      mtime: number;
      kind: 'text' | 'image' | 'pdf' | 'binary';
      mime: string;
      maxBytes: number;
    };

export function useEc2FileContent(path: string | null) {
  return useQuery({
    queryKey: ['ec2-file-content', path],
    queryFn: () =>
      api.get<FileContentResponse>(`/ec2/files/content?path=${encodeURIComponent(path!)}`),
    enabled: !!path,
    staleTime: 5 * 60_000,
    retry: false,
  });
}

// Backend accepts two path shapes:
//   - /home/ubuntu/projects/<name>: full cascade (DynamoDB epics + project
//     registry + agent jobs + S3 apps/<name>/ + EC2 folder + matching
//     ~/.claude/projects/-home-ubuntu-projects-<name> transcript folder)
//   - /home/ubuntu/.claude/projects/<session>: just removes that transcript
//     folder (no AWS cascade)
// `kind` tells the UI which flow ran; `results` is populated for the project
// flow so the operator can see what was cleaned up.
export interface DeleteFolderResult {
  ok: boolean;
  path: string;
  kind: 'project' | 'claude-session';
  transcriptDir?: string;
  transcriptDeleted?: boolean;
  output?: string;
  results?: { step: string; status: string; detail?: string }[];
}

export function useDeleteEc2Folder() {
  const queryClient = useQueryClient();
  return useMutation<DeleteFolderResult, Error, string>({
    mutationFn: (path: string) =>
      api.delete<DeleteFolderResult>(`/ec2/files?path=${encodeURIComponent(path)}`),
    onSuccess: (result) => {
      queryClient.invalidateQueries({ queryKey: ['ec2-files'] });
      // A project delete cascades into epics + party rows, so refresh the
      // caches that back the Labs project picker and epic-workflows list too,
      // otherwise deleted projects linger in the UI until a manual reload.
      if (result.kind === 'project') {
        queryClient.invalidateQueries({ queryKey: ['party', 'projects'] });
        queryClient.invalidateQueries({ queryKey: ['epic-list'] });
        queryClient.invalidateQueries({ queryKey: ['epic-workflow'] });
      }
    },
  });
}
