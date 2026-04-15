'use client';
import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api-client';
import type { AWSResource, ResourceSummary } from '@/types/resource';

export function useProjectResources(projectId: string) {
  return useQuery({
    queryKey: ['resources', projectId],
    queryFn: () =>
      api.get<{ projectId: string; groups: Record<string, AWSResource[]>; total: number }>(
        `/projects/${projectId}/resources`,
      ),
    enabled: !!projectId,
  });
}

export function useResourceSummary() {
  return useQuery({
    queryKey: ['resources', 'summary'],
    queryFn: () => api.get<ResourceSummary>('/resources/summary'),
  });
}
