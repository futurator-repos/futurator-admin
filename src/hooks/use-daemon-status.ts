'use client';
import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api-client';

interface DaemonStatus {
  alive: boolean;
  lastSeen: string | null;
  ageMs?: number;
}

export function useDaemonStatus() {
  return useQuery({
    queryKey: ['daemon-status'],
    queryFn: () => api.get<DaemonStatus>('/daemon/status'),
    refetchInterval: 5000,
  });
}
