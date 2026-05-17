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
