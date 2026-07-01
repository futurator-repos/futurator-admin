'use client';
import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api-client';

interface DaemonStatus {
  alive: boolean;
  lastSeen: string | null;
  ageMs?: number;
  /** Pipeline-3 ready-frontier dispatch mode: 'off' | 'shadow' | 'on' | null (unknown). */
  p3ReadyFrontier?: string | null;
}

export function useDaemonStatus() {
  return useQuery({
    queryKey: ['daemon-status'],
    queryFn: () => api.get<DaemonStatus>('/daemon/status'),
    refetchInterval: 5000,
  });
}
