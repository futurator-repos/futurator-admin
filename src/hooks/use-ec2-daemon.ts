'use client';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api-client';

export interface DaemonProcess {
  jobId: string;
  stepId: string | null;
  agentId: string | null;
  model: string | null;
  pid: number | null;
  startedAt: string;
  workingDir: string;
}

export interface SystemStats {
  totalMem: number; // MB
  freeMem: number; // MB
  loadAvg: number[]; // [1m, 5m, 15m]
}

export interface Ec2Status {
  instanceId: string;
  state: 'pending' | 'running' | 'stopping' | 'stopped' | 'terminated' | 'unknown';
  publicIp?: string;
  daemonAlive: boolean;
  daemonSource: 'local' | 'ec2' | null;
  lastHeartbeat: string | null;
  activeCount: number;
  maxConcurrent: number;
  processes: DaemonProcess[];
  system: SystemStats | null;
}

export function useEc2Status(enabled: boolean) {
  return useQuery({
    queryKey: ['ec2-status'],
    queryFn: () => api.get<Ec2Status>('/ec2/status'),
    enabled,
    refetchInterval: 5000,
  });
}

export function useEnableEc2() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => api.post<{ state: string; message: string }>('/ec2/enable', {}),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['ec2-status'] }),
  });
}

export function useStartEc2Daemon() {
  return useMutation({
    mutationFn: () => api.post<{ commandId: string; message: string }>('/ec2/start-daemon', {}),
  });
}

export function useRefreshEc2Credentials() {
  return useMutation({
    mutationFn: (credentials: string) =>
      api.post<{ commandId: string; message: string }>('/ec2/refresh-credentials', { credentials }),
  });
}

export function useDisableEc2() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => api.post<{ state: string; message: string }>('/ec2/disable', {}),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['ec2-status'] }),
  });
}
