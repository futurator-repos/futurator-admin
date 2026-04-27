'use client';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api-client';

/**
 * Pipeline v1 — Epic 3 (Talk-to-agent).
 */

export interface CreateConversationResult {
  conversationId: string;
  sessionId: string;
  warmth: 'HOT' | 'WARM' | 'COLD' | 'STALE';
  estimatedFirstTurnCost: number;
}

export function useCreateConversation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({
      jobId,
      stepId,
      mode,
    }: {
      jobId: string;
      stepId: string;
      mode?: 'fresh' | 'resume' | 'compact-resume';
    }) =>
      api.post<CreateConversationResult>(`/jobs/${jobId}/steps/${stepId}/conversations`, { mode }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['conversations'] });
    },
  });
}

export function useSendMessage(conversationId: string | null) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (content: string) =>
      api.post<{ messageId: string; jobId: string }>(`/conversations/${conversationId}/messages`, {
        content,
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['conversations', conversationId] });
    },
  });
}

export function useApplyConversationOutput() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (conversationId: string) =>
      api.post<{ ok: true }>(`/conversations/${conversationId}/apply-output`, {}),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['conversations'] });
      queryClient.invalidateQueries({ queryKey: ['plans'] });
    },
  });
}

export function useConversationEvents(conversationId: string | null) {
  return useQuery({
    queryKey: ['conversations', conversationId, 'events'],
    queryFn: () =>
      api.get<{ events: unknown[]; lastSeq: string }>(`/conversations/${conversationId}/events`),
    enabled: !!conversationId,
    refetchInterval: 2_000,
  });
}
