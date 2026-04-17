'use client';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api-client';
import type { EpicWorkflow, CreateEpicInput } from '@/types/epic-workflow';

export interface EpicSummary {
  epicId: string;
  title: string;
  status: string;
  appName: string;
  workingDir: string;
  totalStories: number;
  doneStories: number;
  deployUrl?: string;
  createdAt: string;
}

export function useEpicList() {
  return useQuery({
    queryKey: ['epic-list'],
    queryFn: () => api.get<EpicSummary[]>('/epic-workflows'),
    staleTime: 10_000,
  });
}

export function useEpicWorkflow(epicId: string | null) {
  return useQuery({
    queryKey: ['epic-workflow', epicId],
    queryFn: () => api.get<EpicWorkflow>(`/epic-workflows/${epicId}`),
    enabled: !!epicId,
    retry: (failureCount, error) => {
      if (error instanceof Error && error.message.includes('not found')) return false;
      return failureCount < 2;
    },
    refetchOnWindowFocus: (query) => {
      // Don't refetch deleted epics on tab focus
      return !query.state.error;
    },
    refetchInterval: (query) => {
      if (query.state.error) return false;
      const epic = query.state.data;
      if (!epic) return 3000;
      if (epic.status === 'completed' || epic.status === 'deployed') return false;
      const hasActive = epic.stories.some(
        (s) => s.status === 'running' || s.status === 'in_review' || s.status === 'fixing',
      );
      if (
        hasActive ||
        epic.status === 'in_progress' ||
        epic.status === 'in_review' ||
        epic.status === 'fixing'
      )
        return 3000;
      return false;
    },
  });
}

export function useCreateEpic() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateEpicInput) => api.post<{ epicId: string }>('/epic-workflows', input),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['epic-workflow'] }),
  });
}

export function useDeleteEpic() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (epicId: string) =>
      api.delete<{
        epicId: string;
        appName: string;
        results: { step: string; status: string; detail?: string }[];
      }>(`/epic-workflows/${epicId}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['epic-list'] });
      queryClient.invalidateQueries({ queryKey: ['epic-workflow'] });
    },
  });
}

export function useUpdateEpic() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ epicId, ...fields }: Partial<EpicWorkflow> & { epicId: string }) =>
      api.put<EpicWorkflow>(`/epic-workflows/${epicId}`, fields),
    onSuccess: (_, vars) =>
      queryClient.invalidateQueries({ queryKey: ['epic-workflow', vars.epicId] }),
  });
}

export function useRunStory() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ epicId, storyId }: { epicId: string; storyId: string }) =>
      api.post<{ jobId: string; storyId: string }>(
        `/epic-workflows/${epicId}/stories/${storyId}/run`,
        {},
      ),
    onSuccess: (_, vars) =>
      queryClient.invalidateQueries({ queryKey: ['epic-workflow', vars.epicId] }),
  });
}

// Epic Orchestrator start (EO-4.4/4.6). Returns the jobId for the single
// `phase: 'epic-dev'` job that covers the entire epic. Surfaces 409
// responses so the caller can fall back to per-story mode when the flag
// is disabled server-side.
export function useStartEpicOrchestrator() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (epicId: string) =>
      api.post<{ jobId: string }>(`/epic-workflows/${epicId}/start`, {}),
    onSuccess: (_, epicId) =>
      queryClient.invalidateQueries({ queryKey: ['epic-workflow', epicId] }),
  });
}

export function useRunPoReview() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (epicId: string) =>
      api.post<{ jobId: string; epicId: string }>(`/epic-workflows/${epicId}/po-review`, {}),
    onSuccess: (_, epicId) =>
      queryClient.invalidateQueries({ queryKey: ['epic-workflow', epicId] }),
  });
}

export function useRunVisualQa() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (epicId: string) =>
      api.post<{ jobId: string; epicId: string }>(`/epic-workflows/${epicId}/visual-qa`, {}),
    onSuccess: (_, epicId) =>
      queryClient.invalidateQueries({ queryKey: ['epic-workflow', epicId] }),
  });
}

export function useStartDevServer() {
  return useMutation({
    mutationFn: (epicId: string) =>
      api.post<{ jobId: string; epicId: string }>(`/epic-workflows/${epicId}/dev-server`, {}),
  });
}

export function useDeployApp() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (epicId: string) =>
      api.post<{ jobId: string; appName: string; publicUrl: string }>(
        `/epic-workflows/${epicId}/deploy`,
        {},
      ),
    onSuccess: (_, epicId) =>
      queryClient.invalidateQueries({ queryKey: ['epic-workflow', epicId] }),
  });
}

export interface AppEntry {
  epicId: string;
  title: string;
  appName: string;
  workingDir: string;
  appStatus: 'conceptualized' | 'in_development' | 'deployed';
  url: string | null;
  deployedAt: string | null;
  totalStories: number;
  doneStories: number;
  createdAt: string;
}

export function usePublishedApps() {
  return useQuery({
    queryKey: ['published-apps'],
    queryFn: () => api.get<AppEntry[]>('/apps'),
  });
}

export function useSubmitBugReport() {
  return useMutation({
    mutationFn: ({ projectId, description }: { projectId: string; description: string }) =>
      api.post<{ jobId: string; projectId: string }>(`/projects/${projectId}/bug-report`, {
        description,
      }),
  });
}

export function useSubmitFeatureRequest() {
  return useMutation({
    mutationFn: ({ projectId, description }: { projectId: string; description: string }) =>
      api.post<{ jobId: string; projectId: string; workingDir: string }>(
        `/projects/${projectId}/feature-request`,
        { description },
      ),
  });
}

export function useProjectRegistry(projectId: string | null) {
  return useQuery({
    queryKey: ['project-registry', projectId],
    queryFn: () =>
      api.get<import('@/types/project-registry').ProjectRegistry>(
        `/projects/${projectId}/registry`,
      ),
    enabled: !!projectId,
    staleTime: 30_000,
  });
}

export function useGenerateEpic() {
  return useMutation({
    mutationFn: (input: { idea: string; workingDir: string }) =>
      api.post<{ jobId: string }>('/epic-workflows/generate', input),
  });
}

export function useCreateEpicFromXml() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: {
      xml: string;
      workingDir: string;
      yoloMode?: boolean;
      devModel?: string;
      devEffort?: string;
      reviewerModel?: string;
      reviewerEffort?: string;
    }) => api.post<{ epicId: string; storiesCount: number }>('/epic-workflows/from-xml', input),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['epic-workflow'] }),
  });
}
