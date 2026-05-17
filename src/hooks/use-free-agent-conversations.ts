/**
 * use-free-agent-conversations.ts — Story 18.6 (Epic 18: Free Claude Code Agent)
 *
 * Thread-list data source for the panel-header hamburger dropdown. Polls
 * GET /api/free-agent/conversations?scope= for the operator's recent sessions
 * in the current scope, and exposes a `loadMessages(sessionId)` helper that
 * fetches the full conversation history when the operator clicks a row.
 */

'use client';

import { useQuery } from '@tanstack/react-query';
import { useMemo } from 'react';
import { api } from '@/lib/api-client';
import { useFreeAgentStore, type FreeAgentScope } from '@/stores/free-agent-store';

export interface FreeAgentConversationSummary {
  sessionId: string;
  scope: FreeAgentScope;
  status: string;
  model: string;
  costUsdAccumulated: number;
  turnCount: number;
  lastActivityAt: string;
  firstUserMessagePreview: string | null;
}

export interface FreeAgentLoadedMessage {
  role: 'user' | 'assistant' | 'system';
  content: string;
  createdAt: string;
  tokensIn?: number;
  tokensOut?: number;
  costUsd?: number;
  toolCalls?: Array<{ id: string; name: string; input?: unknown }>;
}

function scopeQueryString(scope: FreeAgentScope): string {
  return scope.kind === 'workspace' ? 'workspace' : `${scope.kind}:${scope.id ?? ''}`;
}

export function useFreeAgentConversations() {
  const scope = useFreeAgentStore((s) => s.currentScope);

  const conversationsQuery = useQuery<FreeAgentConversationSummary[]>({
    queryKey: ['free-agent-conversations', scopeQueryString(scope)],
    queryFn: () =>
      api.get<FreeAgentConversationSummary[]>(
        `/free-agent/conversations?scope=${encodeURIComponent(scopeQueryString(scope))}&limit=10`,
      ),
  });

  return useMemo(
    () => ({
      conversations: conversationsQuery.data ?? [],
      isLoading: conversationsQuery.isLoading,
      refetch: conversationsQuery.refetch,
    }),
    [conversationsQuery.data, conversationsQuery.isLoading, conversationsQuery.refetch],
  );
}

/** One-shot fetch of a session's full message history. Called by the loadSession action. */
export async function fetchSessionMessages(sessionId: string): Promise<FreeAgentLoadedMessage[]> {
  return api.get<FreeAgentLoadedMessage[]>(`/free-agent/sessions/${sessionId}/messages`);
}
