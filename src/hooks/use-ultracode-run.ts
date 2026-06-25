/**
 * use-ultracode-run.ts — lifecycle + dual live stream for one bench run.
 *
 * Mirrors use-free-agent-session: create via POST, then long-poll GET .../events with an
 * eventSeq cursor and a status-driven refetchInterval. The SAME events endpoint multiplexes
 * BOTH engines, tagged `ultracode-bench.case1.*` and `ultracode-bench.case2.*`; we aggregate
 * each channel into the FreeAgentMessage[] shape the existing terminal renderer consumes
 * (both Case 1 and Case 2 are live `claude` runs under the symmetric frame).
 *
 * Long-poll (not SSE) for parity with the free-agent / party-events pattern.
 */

'use client';

import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api-client';
import type { FreeAgentMessage } from '@/components/free-agent/message-thread';
import {
  ACTIVE_STATUSES,
  TERMINAL_STATUSES,
  type UltracodeRun,
  type UltracodeRunStatus,
  type UltracodeRigor,
  type UltracodeTarget,
} from '@/types/ultracode-run';

const POLL_INTERVAL_MS = 1500;

interface CreateRunInput {
  intent: string;
  target: UltracodeTarget;
  rigor: UltracodeRigor;
  reps: number;
}
interface CreateRunResponse {
  runId: string;
  status: UltracodeRunStatus;
}

interface RunEvent {
  jobId: string;
  eventSeq: string;
  timestamp: string;
  eventType: string;
  text?: string;
  tool?: { id?: string; name?: string; input?: Record<string, unknown> };
  [key: string]: unknown;
}
interface EventsResponse {
  events: RunEvent[];
  lastSeq: string;
  status: UltracodeRunStatus;
}

/** Per-run accumulator — held as a single state object so a run change resets it atomically. */
interface Acc {
  lastSeq: string;
  case1: FreeAgentMessage[];
  case2: FreeAgentMessage[];
  c1Active: string | null;
  c2Active: string | null;
}
const EMPTY_ACC: Acc = { lastSeq: '000000', case1: [], case2: [], c1Active: null, c2Active: null };

export interface UseUltracodeRunApi {
  run: UltracodeRun | undefined;
  status: UltracodeRunStatus | undefined;
  isTerminal: boolean;
  case1Messages: FreeAgentMessage[];
  case2Messages: FreeAgentMessage[];
  createRun(input: CreateRunInput, opts?: { onSuccess?: (data: CreateRunResponse) => void }): void;
  isCreating: boolean;
}

/** Aggregate one channel's events into terminal-style bubbles; returns the updated active-bubble id. */
function applyEvents(
  prev: FreeAgentMessage[],
  events: RunEvent[],
  channel: 'case1' | 'case2',
  activeId: string | null,
): { messages: FreeAgentMessage[]; activeId: string | null } {
  const next = [...prev];
  let active = activeId;
  const prefix = `ultracode-bench.${channel}.`;
  for (const ev of events) {
    if (!ev.eventType.startsWith(prefix)) continue;
    const kind = ev.eventType.slice(prefix.length);
    if (kind === 'token' && typeof ev.text === 'string') {
      if (!active) {
        active = `${channel}-assistant-${ev.eventSeq}`;
        next.push({ id: active, role: 'assistant', content: ev.text, timestamp: ev.timestamp });
      } else {
        const idx = next.findIndex((m) => m.id === active);
        if (idx >= 0) next[idx] = { ...next[idx], content: next[idx].content + ev.text };
      }
    } else if (kind === 'tool_use') {
      active = null;
      const tool = ev.tool ?? {};
      next.push({
        id: `${channel}-tool-${ev.eventSeq}`,
        role: 'tool',
        content: formatToolCall(tool),
        timestamp: ev.timestamp,
        toolName: tool.name,
        toolInput: tool.input,
      });
    } else if (kind === 'captured' || kind === 'halted' || kind === 'complete') {
      active = null;
      next.push({
        id: `${channel}-${kind}-${ev.eventSeq}`,
        role: 'system',
        content:
          kind === 'halted'
            ? 'HALTED @ plan produced (subprocess killed on script write)'
            : kind === 'captured'
              ? `Captured plan${typeof ev.scriptPath === 'string' ? ` — ${ev.scriptPath}` : ''}`
              : 'Plan produced',
        timestamp: ev.timestamp,
      });
    } else if (kind === 'tainted' || kind === 'error') {
      active = null;
      const reason = typeof ev.reason === 'string' ? ev.reason : '';
      next.push({
        id: `${channel}-${kind}-${ev.eventSeq}`,
        role: 'system',
        content:
          kind === 'tainted'
            ? `Rep excluded — ${reason || 'no usable plan captured'}`
            : `Run errored${reason ? ` — ${reason}` : ''}`,
        timestamp: ev.timestamp,
      });
    }
  }
  return { messages: next, activeId: active };
}

export function useUltracodeRun(runId: string | null): UseUltracodeRunApi {
  const queryClient = useQueryClient();
  const [acc, setAcc] = useState<Acc>(EMPTY_ACC);

  // Reset the accumulator when the viewed run changes — set DURING RENDER (React's recommended
  // pattern for "adjust state when a prop changes"), not in an effect.
  const [prevRunId, setPrevRunId] = useState<string | null>(runId);
  if (runId !== prevRunId) {
    setPrevRunId(runId);
    setAcc(EMPTY_ACC);
  }

  const runQuery = useQuery<UltracodeRun>({
    queryKey: ['ultracode-run', runId],
    queryFn: () => api.get<UltracodeRun>(`/ultracode/runs/${runId}`),
    enabled: !!runId,
    refetchInterval: (q) => {
      const data = q.state.data as UltracodeRun | undefined;
      if (!data) return false;
      return ACTIVE_STATUSES.has(data.status) ? POLL_INTERVAL_MS : false;
    },
  });

  const status = runQuery.data?.status;
  const isTerminal = !!status && TERMINAL_STATUSES.has(status);

  const eventsQuery = useQuery<EventsResponse>({
    queryKey: ['ultracode-events', runId, acc.lastSeq],
    queryFn: () => api.get<EventsResponse>(`/ultracode/runs/${runId}/events?after=${acc.lastSeq}`),
    enabled: !!runId && !isTerminal,
    refetchInterval:
      status && ACTIVE_STATUSES.has(status) ? POLL_INTERVAL_MS : POLL_INTERVAL_MS * 4,
  });

  const eventsData = eventsQuery.data;
  useEffect(() => {
    if (!eventsData) return;
    const { events, lastSeq: newSeq } = eventsData;
    // Long-poll → aggregate into bubbles. Established repo pattern for streamed events.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setAcc((prev) => {
      if (events.length === 0 && (!newSeq || newSeq === prev.lastSeq)) return prev;
      const c1 = applyEvents(prev.case1, events, 'case1', prev.c1Active);
      const c2 = applyEvents(prev.case2, events, 'case2', prev.c2Active);
      return {
        lastSeq: newSeq || prev.lastSeq,
        case1: c1.messages,
        case2: c2.messages,
        c1Active: c1.activeId,
        c2Active: c2.activeId,
      };
    });
  }, [eventsData]);

  const createRunMutation = useMutation({
    mutationFn: (input: CreateRunInput) => api.post<CreateRunResponse>('/ultracode/runs', input),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['ultracode-runs'] });
    },
  });

  return useMemo<UseUltracodeRunApi>(
    () => ({
      run: runQuery.data,
      status,
      isTerminal,
      case1Messages: acc.case1,
      case2Messages: acc.case2,
      createRun: createRunMutation.mutate,
      isCreating: createRunMutation.isPending,
    }),
    [
      runQuery.data,
      status,
      isTerminal,
      acc.case1,
      acc.case2,
      createRunMutation.mutate,
      createRunMutation.isPending,
    ],
  );
}

/** Compact one-line description of a tool-call payload (mirrors free-agent's formatToolCall). */
function formatToolCall(tool: { name?: string; input?: Record<string, unknown> }): string {
  const name = (tool.name || 'Tool').toLowerCase();
  const input = tool.input || {};
  if (name === 'bash' && typeof input.command === 'string') return input.command;
  for (const key of ['file_path', 'pattern', 'path']) {
    if (typeof input[key] === 'string' && input[key]) return input[key] as string;
  }
  for (const [, v] of Object.entries(input)) {
    if (typeof v === 'string' && v.length > 0) return v;
  }
  return tool.name || 'Tool';
}
