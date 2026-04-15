'use client';
import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api-client';

interface MetricSeries {
  timestamps: string[];
  values: number[];
}

interface MetricsResponse {
  range: string;
  period: number;
  instanceId: string;
  metrics: Record<string, MetricSeries>;
}

interface Snapshot {
  cpu: string;
  memory: string;
  disk: string;
  topProcesses: string;
  claudeProcesses: number;
  daemonStatus: string;
  uptimeSince: string;
}

interface SnapshotResponse {
  state: string;
  snapshot: Snapshot | null;
}

export function useEc2Metrics(range: string, enabled: boolean) {
  return useQuery({
    queryKey: ['ec2-metrics', range],
    queryFn: () => api.get<MetricsResponse>(`/ec2/metrics?range=${range}`),
    enabled,
    refetchInterval: false, // only on demand
    staleTime: 60_000, // 1 minute
  });
}

export function useEc2Snapshot(enabled: boolean) {
  return useQuery({
    queryKey: ['ec2-snapshot'],
    queryFn: () => api.get<SnapshotResponse>('/ec2/snapshot'),
    enabled,
    refetchInterval: false,
    staleTime: 30_000,
  });
}
