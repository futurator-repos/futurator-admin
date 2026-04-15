'use client';
import { useQuery } from '@tanstack/react-query';
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
