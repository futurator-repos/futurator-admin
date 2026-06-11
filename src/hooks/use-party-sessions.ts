'use client';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api-client';
import type { PartySession } from '@/types/party';

export function useSessionsForProject(projectId: string | null) {
  return useQuery({
    queryKey: ['party', 'sessions', 'by-project', projectId],
    queryFn: () => api.get<{ sessions: PartySession[] }>(`/party/projects/${projectId}/sessions`),
    enabled: !!projectId,
    staleTime: 30_000,
  });
}

/** Cross-project listing for the Debates page — newest-activity-first. */
export function useAllPartySessions() {
  return useQuery({
    queryKey: ['party', 'sessions', 'all'],
    queryFn: () => api.get<{ sessions: PartySession[] }>('/party/sessions'),
    staleTime: 30_000,
    refetchInterval: 60_000,
  });
}

/**
 * Delete a debate. The API runs the full Story 20.10 cascade: archive the
 * party branch (push to archive/party/<app>/<sid>), drop it, remove the
 * per-session worktree, delete inline questions + the session row.
 * Best-effort per step — the response carries `results[]` with per-step
 * status so callers can surface partial failures.
 */
export function useDeleteSessionMutation() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (sessionId: string) =>
      api.delete<{ sessionId: string; results: Array<{ step: string; status: string }> }>(
        `/party/sessions/${sessionId}`,
      ),
    onSuccess: () => {
      // Drop every sessions listing (all + every by-project key) in one go.
      qc.invalidateQueries({ queryKey: ['party', 'sessions'] });
    },
  });
}

export function useCreateSessionMutation() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ projectId, topic }: { projectId: string; topic?: string }) =>
      api.post<PartySession>('/party/sessions', { projectId, topic }),
    onSuccess: (session) => {
      qc.invalidateQueries({
        queryKey: ['party', 'sessions', 'by-project', session.projectId],
      });
      // Also invalidate the cross-project listing used by the Debates page so
      // the new session shows up without a manual refresh.
      qc.invalidateQueries({ queryKey: ['party', 'sessions', 'all'] });
      qc.setQueryData(['party', 'session', session.sessionId], session);
    },
  });
}
