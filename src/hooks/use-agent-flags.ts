'use client';
/**
 * use-agent-flags — 2026-05-27 PR B.f.
 *
 * TanStack Query wrapper around /api/admin/flags + /api/admin/pause + resume.
 * The header AgentPauseToggle reads `isPaused` and mutates via these hooks.
 *
 * The query polls every 10s so a CLI-driven `npm run agent:pause` propagates
 * to all open browser tabs within ~10s without manual refresh. Daemon-side
 * cache is 5s; total perceived latency ≈ 15s worst case.
 */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api-client';

export interface AgentFlag {
  flagName: string;
  value: string;
  updatedBy: string;
  updatedAt: string;
}

const QK_FLAGS = ['agent', 'flags'] as const;
const POLL_MS = 10_000;

export function useAgentFlags() {
  return useQuery({
    queryKey: QK_FLAGS,
    queryFn: () => api.get<{ flags: AgentFlag[] }>('/api/admin/flags').then((r) => r.flags),
    refetchInterval: POLL_MS,
    staleTime: POLL_MS,
  });
}

/**
 * Convenience: is `agent.paused` currently set to 'true'?
 * Returns false when the flag has never been written (default off).
 */
export function useIsAgentPaused() {
  const { data } = useAgentFlags();
  const paused = data?.find((f) => f.flagName === 'agent.paused');
  return paused?.value === 'true';
}

export function usePauseAgent() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () =>
      api.post<{ paused: true; updatedBy: string; updatedAt: string }>('/api/admin/pause', {}),
    onSuccess: () => qc.invalidateQueries({ queryKey: QK_FLAGS }),
  });
}

export function useResumeAgent() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () =>
      api.post<{ paused: false; updatedBy: string; updatedAt: string }>('/api/admin/resume', {}),
    onSuccess: () => qc.invalidateQueries({ queryKey: QK_FLAGS }),
  });
}
