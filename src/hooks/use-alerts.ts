'use client';
import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api-client';
import type { Alert } from '@/types/alert';

export function useAlerts(projectId?: string) {
  return useQuery({
    queryKey: ['alerts', projectId],
    queryFn: () => api.get<Alert[]>(projectId ? `/alerts?projectId=${projectId}` : '/alerts'),
  });
}
