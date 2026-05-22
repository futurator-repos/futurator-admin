'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api-client';
import type { PartyEvent } from '@/types/party';

/**
 * Story 22.2 — typed response from GET /api/party/sessions/:id/audit.
 */
export interface PartyAuditResponse {
  sessionId: string;
  projectId: string;
  partyBranch: string | null;
  worktreePath: string | null;
  tally: {
    checkpointsPushed: number;
    checkpointsComposed: number;
    checkpointsBlocked: number;
    checkpointsFailed: number;
    questions: number;
    defaultAllows: number;
  };
  events: PartyEvent[];
}

/**
 * Story 22.7 — fetches the audit slice for a session. The drawer
 * UI calls this when opened; refetch is operator-driven (Refresh
 * button) so we don't burn DDB read units on a card the operator
 * isn't looking at.
 */
export function usePartyAudit(sessionId: string | null, enabled = true) {
  return useQuery({
    queryKey: ['party-audit', sessionId],
    queryFn: () => api.get<PartyAuditResponse>(`/party/sessions/${sessionId}/audit`),
    enabled: enabled && !!sessionId,
    staleTime: 15_000,
  });
}

/** Story 22.3 response shape. */
export interface OpenPrResponse {
  prNumber: number;
  prUrl: string;
  title: string;
  state: string;
  reused: boolean;
}

/**
 * Story 22.3 — opens (or fetches existing) PR for a session's checkpoint.
 * The card's "Open PR" button calls this; on success the operator gets
 * the prUrl returned in the response and the UI can navigate to it in
 * a new tab.
 */
export function useOpenCheckpointPr() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({
      sessionId,
      sha,
      title,
      body,
      draft,
    }: {
      sessionId: string;
      sha: string;
      title?: string;
      body?: string;
      draft?: boolean;
    }) =>
      api.post<OpenPrResponse>(
        `/party/sessions/${encodeURIComponent(sessionId)}/checkpoints/${sha}/pr`,
        {
          ...(title ? { title } : {}),
          ...(body ? { body } : {}),
          ...(draft !== undefined ? { draft } : {}),
        },
      ),
    onSuccess: (_data, vars) => {
      qc.invalidateQueries({ queryKey: ['party-audit', vars.sessionId] });
    },
  });
}
