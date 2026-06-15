'use client';
/**
 * use-agent-spend — 2026-05-27 PR B.c.
 *
 * Daily spend rollup hook. Backs the header pill that surfaces today's
 * accumulated agent walltime + dollar cost. Polls every 30s — daemon
 * writes a row only per completed job, so cheaper polling than the flag
 * hook is fine; the pill is informational, not load-bearing.
 */

import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api-client';

export interface DailySpend {
  date: string;
  totalCostUsd: number;
  totalWalltimeSec: number;
  rowCount: number;
}

const POLL_MS = 30_000;

export function useTodaysAgentSpend() {
  return useQuery({
    queryKey: ['agent', 'spend', 'today'],
    // base URL already ends in /api — pass the path WITHOUT a second /api prefix
    // (a leading /api here produced /api/api/admin/spend → 404, 2026-06-16)
    queryFn: () => api.get<DailySpend>('/admin/spend'),
    refetchInterval: POLL_MS,
    staleTime: POLL_MS,
  });
}
