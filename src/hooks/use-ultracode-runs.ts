/**
 * use-ultracode-runs.ts — the bench corpus list (operator-scoped, newest first).
 */

'use client';

import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api-client';
import type { UltracodeRunSummary } from '@/types/ultracode-run';

interface RunsResponse {
  runs: UltracodeRunSummary[];
}

export function useUltracodeRuns() {
  return useQuery<RunsResponse>({
    queryKey: ['ultracode-runs'],
    queryFn: () => api.get<RunsResponse>('/ultracode/runs'),
    staleTime: 5 * 60 * 1000,
  });
}
