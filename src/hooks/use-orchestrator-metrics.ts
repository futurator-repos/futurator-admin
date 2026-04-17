'use client';
import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api-client';

export type ModelTier = 'opus' | 'sonnet' | 'haiku' | 'unknown';

export interface WallClockStats {
  count: number;
  medianMs: number;
  p95Ms: number;
}

export interface OrchestratorMetrics {
  sampleSize: number;
  epic: WallClockStats;
  story: WallClockStats;
  tokenSpend: Record<ModelTier, number>;
  remediation: {
    epicsWithRemediations: number;
    epicsTotal: number;
    rate: number;
  };
  blockerTaxonomy: Record<string, number>;
}

export interface MetricsResponse {
  filter: {
    from: number | null;
    to: number | null;
    projectId: string | null;
    useEpicOrchestrator: string | null;
  };
  metrics: OrchestratorMetrics;
}

export interface MetricsQuery {
  /** ISO string, epoch ms, or a relative window like `7d` / `30d`. */
  from?: string;
  to?: string;
  project?: string;
  useEpicOrchestrator?: 'true' | 'false';
}

function resolveFrom(from: string | undefined): string | undefined {
  if (!from) return undefined;
  const rel = /^(\d+)d$/.exec(from);
  if (!rel) return from;
  const days = Number(rel[1]);
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
}

function buildQueryString(q: MetricsQuery): string {
  const params = new URLSearchParams();
  const from = resolveFrom(q.from);
  if (from) params.set('from', from);
  if (q.to) params.set('to', q.to);
  if (q.project) params.set('project', q.project);
  if (q.useEpicOrchestrator) params.set('useEpicOrchestrator', q.useEpicOrchestrator);
  const s = params.toString();
  return s ? `?${s}` : '';
}

export function useOrchestratorMetrics(query: MetricsQuery = {}) {
  return useQuery({
    queryKey: ['reports', 'epic-orchestrator-metrics', query],
    queryFn: () =>
      api.get<MetricsResponse>(`/reports/epic-orchestrator-metrics${buildQueryString(query)}`),
  });
}
