/**
 * use-free-agent-session.ts — Story 18.5 (Epic 18: Free Claude Code Agent)
 *
 * Single hook that orchestrates the widget's session lifecycle:
 *   - Create session (on first send) via POST /api/free-agent/sessions
 *   - Send message via POST /api/free-agent/sessions/:id/messages
 *   - Poll events via GET /api/free-agent/sessions/:id/events?after=<seq>
 *     (1500ms while status === 'PROCESSING'; stops on terminal state)
 *   - Aggregate streamed tokens into the active assistant message bubble
 *   - Expose cost-burn + cost-cap + status to the panel header + composer
 *
 * Long-poll (NOT true SSE) for v1 per the existing party-events pattern.
 * True SSE upgrade is a v1.1 follow-up if perceived latency becomes a problem.
 */

'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api-client';
import { useFreeAgentStore, type FreeAgentScope } from '@/stores/free-agent-store';
import type { FreeAgentMessage } from '@/components/free-agent/message-thread';
import { fetchSessionMessages } from '@/hooks/use-free-agent-conversations';

const DEFAULT_COST_CAP_USD = 10;
const POLL_INTERVAL_MS = 1500;

type FreeAgentStatus =
  | 'IDLE_NO_SESSION'
  | 'ACTIVE'
  | 'PROCESSING'
  | 'IDLE'
  | 'EXPIRED'
  | 'BUDGET_EXHAUSTED'
  | 'ERROR';

interface SessionStateResponse {
  sessionId: string;
  status: Exclude<FreeAgentStatus, 'IDLE_NO_SESSION'>;
  model: string;
  costCapUsd: number;
  costUsdAccumulated: number;
  tokensInAccumulated: number;
  tokensOutAccumulated: number;
  turnCount: number;
  lastActivityAt: string;
  claudeSessionId: string | null;
  errorReason: string | null;
  scope: FreeAgentScope;
}

interface CreateSessionResponse {
  sessionId: string;
  status: 'ACTIVE';
  model: string;
  costCapUsd: number;
}

interface EventsResponse {
  events: Array<{
    jobId: string;
    eventSeq: string;
    timestamp: string;
    eventType: string;
    text?: string;
    payload?: Record<string, unknown>;
  }>;
  lastSeq: string;
}

interface UseFreeAgentSessionApi {
  messages: FreeAgentMessage[];
  isSending: boolean;
  status: FreeAgentStatus;
  costUsdAccumulated: number;
  costCapUsd: number;
  tokensInAccumulated: number;
  tokensOutAccumulated: number;
  sendMessage(content: string): void;
  setCostCapUsd(capUsd: number): void;
  resetSession(): void;
  /** Forks the session with a new model (Story 18.5 AC #6). */
  changeModel(newModel: string): void;
  currentModel: string;
  /** Story 18.6 — resume a prior session; loads its message history. */
  loadSession(sessionId: string): Promise<void>;
}

export function useFreeAgentSession(): UseFreeAgentSessionApi {
  const scope = useFreeAgentStore((s) => s.currentScope);
  const activeSessionId = useFreeAgentStore((s) => s.activeSessionId);
  const setActiveSessionId = useFreeAgentStore((s) => s.setActiveSessionId);
  const queryClient = useQueryClient();

  // Last-used model preference (Story 18.5 AC #5).
  const [currentModel, setCurrentModel] = useState<string>(() => readLastUsedModel());

  // Local-only message accumulator. The conversation persistence table is
  // Story 18.6; for v1 we hold messages in memory keyed by activeSessionId.
  const [messages, setMessages] = useState<FreeAgentMessage[]>([]);
  const [lastSeq, setLastSeq] = useState<string>('000000');
  const activeAssistantIdRef = useRef<string | null>(null);

  // Reset local state when the session changes. This is the "reset state on
  // prop change" pattern documented in https://react.dev/learn/you-might-not-
  // need-an-effect#resetting-all-state-when-a-prop-changes. A cleaner long-
  // term fix would be to pass `key={activeSessionId}` from the parent so React
  // remounts the hook's owner; but since this hook is consumed by the panel
  // (which the operator expects to stay mounted across model-fork events), the
  // ref-comparison alternative is the right shape here.
  const prevSessionIdRef = useRef<string | null>(null);
  useEffect(() => {
    if (prevSessionIdRef.current !== activeSessionId) {
      prevSessionIdRef.current = activeSessionId;
      setMessages([]);
      setLastSeq('000000');
      activeAssistantIdRef.current = null;
    }
  }, [activeSessionId]);

  // Poll session state (status, costs, etc).
  const sessionStateQuery = useQuery<SessionStateResponse>({
    queryKey: ['free-agent-session', activeSessionId],
    queryFn: () => api.get<SessionStateResponse>(`/free-agent/sessions/${activeSessionId}`),
    enabled: !!activeSessionId,
    refetchInterval: (q) => {
      const data = q.state.data as SessionStateResponse | undefined;
      if (!data) return false;
      return data.status === 'PROCESSING' ? POLL_INTERVAL_MS : false;
    },
  });

  // Poll events. Same gating; advances `lastSeq` on each successful page.
  const eventsQuery = useQuery<EventsResponse>({
    queryKey: ['free-agent-events', activeSessionId, lastSeq],
    queryFn: async () => {
      const result = await api.get<EventsResponse>(
        `/free-agent/sessions/${activeSessionId}/events?after=${lastSeq}`,
      );
      return result;
    },
    enabled: !!activeSessionId && sessionStateQuery.data?.status === 'PROCESSING',
    refetchInterval: POLL_INTERVAL_MS,
  });

  // Aggregate events into messages.
  useEffect(() => {
    if (!eventsQuery.data) return;
    const { events, lastSeq: newSeq } = eventsQuery.data;
    if (events.length === 0) return;

    setMessages((prev) => {
      const next = [...prev];
      for (const ev of events) {
        if (ev.eventType === 'free-agent.turn.token' && typeof ev.text === 'string') {
          if (!activeAssistantIdRef.current) {
            const id = `assistant-${ev.eventSeq}`;
            activeAssistantIdRef.current = id;
            next.push({ id, role: 'assistant', content: ev.text, timestamp: ev.timestamp });
          } else {
            const idx = next.findIndex((m) => m.id === activeAssistantIdRef.current);
            if (idx >= 0) next[idx] = { ...next[idx], content: next[idx].content + ev.text };
          }
        } else if (ev.eventType === 'free-agent.turn.complete') {
          activeAssistantIdRef.current = null;
        } else if (
          ev.eventType === 'free-agent.turn.error' ||
          ev.eventType === 'free-agent.budget.exhausted'
        ) {
          activeAssistantIdRef.current = null;
          next.push({
            id: `system-${ev.eventSeq}`,
            role: 'system',
            content:
              ev.eventType === 'free-agent.budget.exhausted'
                ? 'Budget exhausted — raise the cap or end this session.'
                : 'Turn failed. Try again or open a new conversation.',
            timestamp: ev.timestamp,
          });
        }
      }
      return next;
    });
    if (newSeq !== lastSeq) setLastSeq(newSeq);
  }, [eventsQuery.data, lastSeq]);

  // POST /sessions
  const createSession = useMutation({
    mutationFn: async (input: { model: string; scope: FreeAgentScope }) => {
      return api.post<CreateSessionResponse>('/free-agent/sessions', {
        scope: input.scope,
        model: input.model,
        costCapUsd: DEFAULT_COST_CAP_USD,
      });
    },
    onSuccess: (data) => {
      setActiveSessionId(data.sessionId);
    },
  });

  // POST /messages
  const sendMessageMutation = useMutation({
    mutationFn: async (input: { sessionId: string; content: string }) => {
      return api.post<{ jobId: string; status: string }>(
        `/free-agent/sessions/${input.sessionId}/messages`,
        { content: input.content },
      );
    },
    onSuccess: () => {
      // Force the session-state query to refetch immediately so polling kicks in.
      queryClient.invalidateQueries({ queryKey: ['free-agent-session', activeSessionId] });
    },
  });

  // setCostCap is wired through the next message-enqueue (Story 18.5 AC #7
  // says it can be either via PATCH or via in-line update on next message).
  // For v1 we just track it locally; the next sendMessage POST re-creates the
  // session if model changed (which is the only path that resets the cap).
  // True dynamic cap-update via PATCH endpoint is a follow-up.
  const setCostCapUsd = useCallback(
    (capUsd: number) => {
      // Optimistic local update; the server-side `setCostCapUsd` repo helper
      // (Story 18.5) lands in v1.1 wiring once a PATCH endpoint exists.
      // For v1 the operator can change the cap by starting a new conversation.
      if (!activeSessionId) return;
      queryClient.setQueryData<SessionStateResponse | undefined>(
        ['free-agent-session', activeSessionId],
        (prev) => (prev ? { ...prev, costCapUsd: capUsd } : prev),
      );
    },
    [activeSessionId, queryClient],
  );

  // Public API: sendMessage. Creates a session lazily on first call.
  const sendMessage = useCallback(
    (content: string) => {
      if (!content.trim()) return;

      // Optimistically push the user message.
      const userId = `user-${Date.now()}`;
      setMessages((prev) => [
        ...prev,
        { id: userId, role: 'user', content, timestamp: new Date().toISOString() },
      ]);

      if (!activeSessionId) {
        createSession.mutate(
          { model: currentModel, scope },
          {
            onSuccess: (data) => {
              sendMessageMutation.mutate({ sessionId: data.sessionId, content });
            },
          },
        );
      } else {
        sendMessageMutation.mutate({ sessionId: activeSessionId, content });
      }
    },
    [activeSessionId, scope, currentModel, createSession, sendMessageMutation],
  );

  // Model change → fork session.
  const changeModel = useCallback(
    (newModel: string) => {
      writeLastUsedModel(newModel);
      setCurrentModel(newModel);
      if (activeSessionId) {
        // Fork: clear active session + emit a system message.
        setActiveSessionId(null);
        setMessages((prev) => [
          ...prev,
          {
            id: `system-model-change-${Date.now()}`,
            role: 'system',
            content: `Started new conversation with ${modelLabel(newModel)}`,
            timestamp: new Date().toISOString(),
          },
        ]);
      }
    },
    [activeSessionId, setActiveSessionId],
  );

  const resetSession = useCallback(() => {
    setActiveSessionId(null);
    setMessages([]);
    setLastSeq('000000');
    activeAssistantIdRef.current = null;
  }, [setActiveSessionId]);

  /**
   * Story 18.6 — resume a prior session by loading its message history into
   * the thread and pointing the polling queries at the new sessionId.
   *
   * The system message "Session resumed" is appended so the operator sees a
   * clear marker that the visible thread is historical, not a fresh chat.
   */
  const loadSession = useCallback(
    async (sessionId: string) => {
      try {
        const history = await fetchSessionMessages(sessionId);
        const loaded: FreeAgentMessage[] = history.map((m, idx) => ({
          id: `loaded-${sessionId}-${idx}`,
          role: m.role,
          content: m.content,
          timestamp: m.createdAt,
        }));
        setMessages([
          ...loaded,
          {
            id: `system-resume-${Date.now()}`,
            role: 'system',
            content: 'Session resumed',
            timestamp: new Date().toISOString(),
          },
        ]);
        setLastSeq('000000');
        activeAssistantIdRef.current = null;
        setActiveSessionId(sessionId);
      } catch (err) {
        // Network or 403/404 → surface a system error in the thread.
        setMessages((prev) => [
          ...prev,
          {
            id: `system-load-error-${Date.now()}`,
            role: 'system',
            content: `Failed to load session: ${(err as Error).message || 'unknown error'}`,
            timestamp: new Date().toISOString(),
          },
        ]);
      }
    },
    [setActiveSessionId],
  );

  const state = sessionStateQuery.data;
  const status: FreeAgentStatus = activeSessionId ? (state?.status ?? 'ACTIVE') : 'IDLE_NO_SESSION';

  return useMemo<UseFreeAgentSessionApi>(
    () => ({
      messages,
      isSending: sendMessageMutation.isPending || createSession.isPending,
      status,
      costUsdAccumulated: state?.costUsdAccumulated ?? 0,
      costCapUsd: state?.costCapUsd ?? DEFAULT_COST_CAP_USD,
      tokensInAccumulated: state?.tokensInAccumulated ?? 0,
      tokensOutAccumulated: state?.tokensOutAccumulated ?? 0,
      sendMessage,
      setCostCapUsd,
      resetSession,
      changeModel,
      currentModel,
      loadSession,
    }),
    [
      messages,
      sendMessageMutation.isPending,
      createSession.isPending,
      status,
      state,
      sendMessage,
      setCostCapUsd,
      resetSession,
      changeModel,
      currentModel,
      loadSession,
    ],
  );
}

// ── Helpers ─────────────────────────────────────────────────────────

const LAST_USED_MODEL_KEY = 'futurator.free-agent.last-model';

function readLastUsedModel(): string {
  if (typeof window === 'undefined') return 'sonnet';
  return window.localStorage.getItem(LAST_USED_MODEL_KEY) || 'sonnet';
}

function writeLastUsedModel(model: string): void {
  if (typeof window === 'undefined') return;
  window.localStorage.setItem(LAST_USED_MODEL_KEY, model);
}

function modelLabel(model: string): string {
  switch (model) {
    case 'haiku':
      return 'Haiku';
    case 'sonnet':
      return 'Sonnet';
    case 'opus':
      return 'Opus';
    default:
      return model;
  }
}
