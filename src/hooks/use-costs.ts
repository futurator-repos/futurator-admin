'use client';
import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api-client';
import type { CostOverview, CostRecord, CostForecast } from '@/types/cost';

export function useCostOverview() {
  return useQuery({
    queryKey: ['costs', 'overview'],
    queryFn: () => api.get<CostOverview>('/costs/overview'),
  });
}

export function useProjectCosts(projectId: string, range: '30d' | '60d' | '90d' = '30d') {
  return useQuery({
    queryKey: ['costs', projectId, range],
    queryFn: () =>
      api.get<{
        projectId: string;
        period: { start: string; end: string };
        daily: CostRecord[];
        forecast: { endOfMonth: number; confidence: string } | null;
        anomalies: { service: string; amount: number; expectedAmount: number; severity: string }[];
        budget: { limit: number; used: number; percentUsed: number } | null;
      }>(`/projects/${projectId}/costs?range=${range}`),
    enabled: !!projectId,
  });
}

export function useCostForecast() {
  return useQuery({
    queryKey: ['costs', 'forecast'],
    queryFn: () => api.get<CostForecast[]>('/costs/forecast'),
  });
}

export function useCostProviders() {
  return useQuery({
    queryKey: ['costs', 'providers'],
    queryFn: () => api.get<{ provider: string; amount: number }[]>('/costs/providers'),
  });
}
