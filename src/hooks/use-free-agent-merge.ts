'use client';
/**
 * use-free-agent-merge — 2026-05-27 PR B.d/B.e.
 *
 * TanStack mutations for the three Rung 1 endpoints:
 *   POST /api/free-agent/sessions/:id/open-pr
 *   POST /api/free-agent/sessions/:id/approve-merge
 *   POST /api/free-agent/sessions/:id/reject-merge
 *
 * Read state for the inline card comes from the session row + the event
 * stream (merge.requested / .completed / .rejected events are aggregated
 * by use-free-agent-session.ts into a "mergeRequest" object on each
 * message bubble; this hook just powers the buttons).
 */

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api-client';

export interface OpenPrInput {
  title: string;
  body?: string;
}

export interface OpenPrResponse {
  prNumber: number;
  prUrl: string;
  headSha: string;
  riskClass: 'red' | 'yellow' | 'green';
  riskReasons: string[];
  diffSummary: { additions: number; deletions: number; filesChanged: number };
}

export interface ApproveMergeInput {
  /** Required for red-class merges; must match the PR title verbatim. */
  typedConfirmation?: string;
}

export interface ApproveMergeResponse {
  prNumber: number;
  prUrl: string;
  mergeSha: string;
  merged: true;
}

export interface RejectMergeInput {
  reason: string;
}

export interface RejectMergeResponse {
  prNumber: number;
  prUrl: string;
  rejected: true;
  reason: string;
}

export function useOpenPr(sessionId: string | null) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: OpenPrInput) => {
      if (!sessionId) throw new Error('no session');
      return api.post<OpenPrResponse>(`/api/free-agent/sessions/${sessionId}/open-pr`, input);
    },
    onSuccess: () => {
      if (sessionId) {
        qc.invalidateQueries({ queryKey: ['free-agent-session', sessionId] });
        qc.invalidateQueries({ queryKey: ['free-agent-events', sessionId] });
      }
    },
  });
}

export function useApproveMerge(sessionId: string | null) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: ApproveMergeInput) => {
      if (!sessionId) throw new Error('no session');
      return api.post<ApproveMergeResponse>(
        `/api/free-agent/sessions/${sessionId}/approve-merge`,
        input,
      );
    },
    onSuccess: () => {
      if (sessionId) {
        qc.invalidateQueries({ queryKey: ['free-agent-session', sessionId] });
        qc.invalidateQueries({ queryKey: ['free-agent-events', sessionId] });
      }
    },
  });
}

export function useRejectMerge(sessionId: string | null) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: RejectMergeInput) => {
      if (!sessionId) throw new Error('no session');
      return api.post<RejectMergeResponse>(
        `/api/free-agent/sessions/${sessionId}/reject-merge`,
        input,
      );
    },
    onSuccess: () => {
      if (sessionId) {
        qc.invalidateQueries({ queryKey: ['free-agent-session', sessionId] });
        qc.invalidateQueries({ queryKey: ['free-agent-events', sessionId] });
      }
    },
  });
}

/**
 * 2026-05-27 PR D.e — Retry-wave affordance.
 *
 * Calls POST /api/pipelines/:planId/waves/:waveNumber/retry. Used by the
 * inline merge-approval card's [Retry wave N] button after merge.completed
 * for PRs that carried a `targetWaveFailure`. Single-tap only per §9.2
 * RESOLVED.
 */
export interface RetryWaveResponse {
  planId: string;
  waveNumber: number;
  jobId: string;
  message: string;
}

export function useRetryWave() {
  return useMutation({
    mutationFn: (input: { planId: string; waveNumber: number }) =>
      api.post<RetryWaveResponse>(
        `/api/pipelines/${encodeURIComponent(input.planId)}/waves/${input.waveNumber}/retry`,
        {},
      ),
  });
}
