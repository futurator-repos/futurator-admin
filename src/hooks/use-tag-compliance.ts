'use client';
import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api-client';
import type { AuditResult } from '@/types/api';

export function useTagCompliance() {
  return useQuery({
    queryKey: ['tags', 'compliance'],
    queryFn: () => api.get<AuditResult[]>('/tags/compliance'),
  });
}
