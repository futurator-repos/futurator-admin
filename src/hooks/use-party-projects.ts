'use client';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api-client';
import type {
  PartyProject,
  PartyListProjectsResponse,
  PartyBootstrapResponse,
} from '@/types/party';

export function usePartyProjects(enabled = true) {
  return useQuery({
    queryKey: ['party', 'projects'],
    queryFn: () => api.get<PartyListProjectsResponse>('/party/projects'),
    staleTime: 5 * 60 * 1000,
    refetchInterval: (query) => {
      // If any project is INSTALLING, poll every 2s for status transitions.
      const projects = query.state.data?.projects;
      if (!projects) return false;
      const anyInstalling = projects.some((p) => p.bmadStatus === 'INSTALLING');
      return anyInstalling ? 2000 : false;
    },
    enabled,
  });
}

export function usePartyProject(projectId: string | null) {
  return useQuery({
    queryKey: ['party', 'project', projectId],
    queryFn: () => api.get<PartyProject>(`/party/projects/${projectId}`),
    enabled: !!projectId,
    staleTime: 5_000,
    // Poll while BMAD is installing so the UI transitions to HEALTHY without
    // a manual refresh. Stops once the server reports a terminal state.
    refetchInterval: (query) => {
      const status = query.state.data?.bmadStatus;
      return status === 'INSTALLING' ? 2000 : false;
    },
    retry: (failureCount, error) => {
      if (error instanceof Error && /404|not found/i.test(error.message)) return false;
      return failureCount < 2;
    },
  });
}

/**
 * Enable Party Mode on a plan that was created without BMAD (or re-trigger a
 * failed install). Server endpoint: POST /api/plans/:id/bmad/install. Response
 * is 202 with `{ planId, bmadJobId?, inProgress }`.
 */
export function useInstallBmadForPlan() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (planId: string) =>
      api.post<{ planId: string; bmadJobId?: string; inProgress: boolean }>(
        `/plans/${planId}/bmad/install`,
        {},
      ),
    onSuccess: (_data, planId) => {
      qc.invalidateQueries({ queryKey: ['plan', planId] });
      qc.invalidateQueries({ queryKey: ['plans'] });
      qc.invalidateQueries({ queryKey: ['party', 'projects'] });
    },
  });
}

export function useBootstrapMutation() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({
      projectId,
      forceReinstall,
      createFolder,
    }: {
      projectId: string;
      forceReinstall?: boolean;
      createFolder?: boolean;
    }) =>
      api.post<PartyBootstrapResponse>(`/party/projects/${projectId}/bootstrap`, {
        forceReinstall: !!forceReinstall,
        createFolder: !!createFolder,
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['party', 'projects'] });
      qc.invalidateQueries({ queryKey: ['party', 'project'] });
    },
  });
}

export function useInspectMutation() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (projectId: string) =>
      api.post<PartyBootstrapResponse>(`/party/projects/${projectId}/inspect`, {}),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['party', 'projects'] });
    },
  });
}

/**
 * Update mutable Party project settings — currently just `allowedTools`.
 * Optimistic so the UI flips immediately; rolled back on error.
 *
 * Pass `null` to clear the field and restore daemon defaults; pass `[]`
 * to deny all extras.
 */
export function useUpdatePartyProject(projectId: string | null) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (patch: { allowedTools: string[] | null }) => {
      if (!projectId) throw new Error('projectId is required');
      return api.patch<PartyProject>(`/party/projects/${projectId}`, patch);
    },
    onMutate: async (patch) => {
      if (!projectId) return;
      await qc.cancelQueries({ queryKey: ['party', 'project', projectId] });
      const prev = qc.getQueryData<PartyProject>(['party', 'project', projectId]);
      if (prev) {
        qc.setQueryData<PartyProject>(['party', 'project', projectId], {
          ...prev,
          allowedTools: patch.allowedTools ?? undefined,
        });
      }
      return { prev };
    },
    onError: (_err, _vars, ctx) => {
      if (ctx?.prev && projectId) {
        qc.setQueryData(['party', 'project', projectId], ctx.prev);
      }
    },
    onSettled: () => {
      qc.invalidateQueries({ queryKey: ['party', 'project', projectId] });
      qc.invalidateQueries({ queryKey: ['party', 'projects'] });
    },
  });
}
