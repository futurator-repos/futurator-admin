/**
 * Adapter: PartyEvent[] → Round[]
 *
 * Walks a session's event stream and groups it into rounds. One round = one
 * user message plus the assistant response that follows (until the next user
 * message or end of stream).
 *
 * The shape matches the V2 UI spec data model in
 * `docs/concepts/party-mode/party-mode-ui2.md` §10. We deliberately keep
 * adapter logic separate from React rendering so it's testable in isolation.
 */

import type { PartyEvent } from '@/types/party';
import { parseTurn, mergeAssistantTokens, type PartyBlock } from './turn-parser';

export type RoundStatus = 'active' | 'done' | 'awaiting' | 'error';

export interface RoundSpeaker {
  name: string;
  /** True if this agent is currently streaming (last block in active round). */
  current?: boolean;
}

export interface ToolCall {
  id: string;
  name: string;
  /** Trimmed tool input (file_path, command, pattern, etc). */
  input: Record<string, unknown>;
  /** ISO timestamp the daemon emitted the tool_use event. */
  timestamp: string;
}

/**
 * Story 21.5 / 22.5 — per-round checkpoint summary. Adapter collects the
 * terminal checkpoint event of a round (composed | pushed | blocked |
 * failed) so the round renderer can show a single card without re-scanning
 * the full event stream.
 */
export interface RoundCheckpoint {
  kind: 'composed' | 'pushed' | 'blocked' | 'failed';
  title?: string;
  summary?: string;
  branch?: string;
  commitSha?: string | null;
  pushed: boolean;
  reason: string;
  exitCode: number | null;
  timestamp: string;
}

export interface Round {
  /** `r-1`, `r-2`, … (1-indexed). */
  id: string;
  /** Turn number (1-indexed). */
  n: number;
  status: RoundStatus;
  /** ISO timestamp of the user message that started the round. */
  startedAt: string;
  /** User question (the prompt that opened this round). */
  user: { text: string; timestamp: string };
  /** All assistant blocks for this round, in order. */
  blocks: PartyBlock[];
  /**
   * Tool calls observed during this round, in order. Today they're all
   * collected at the round level — most fire from BMad Master before any
   * agent text arrives, so per-block attribution would be misleading. The
   * UI groups them under one collapsible "Actions" panel inside the
   * orchestrator-open container.
   */
  tools: ToolCall[];
  /** Distinct agent speakers in this round (in first-speaker order). */
  speakers: string[];
  /** Approx turn count = #agent blocks. Used for the "5 agents · 8 turns" meta. */
  turns: number;
  /** Last error reason if `status === 'error'`. */
  errorReason?: string;
  /** True if this is the round currently in flight (matches session status). */
  isInflight: boolean;
  /**
   * Story 21.5 — terminal checkpoint event for this round, if one was
   * emitted by the daemon. Render after the assistant blocks so the
   * operator sees what landed in git after the agent finished speaking.
   */
  checkpoint?: RoundCheckpoint;
}

export interface AdaptedSession {
  rounds: Round[];
  /** Most recent round id — what the right rail shows highlighted by default. */
  activeRoundId: string | null;
  /** True if the underlying session is still PROCESSING. */
  isProcessing: boolean;
}

interface RawRound {
  startEvent: PartyEvent;
  events: PartyEvent[]; // events between this user message and the next user message
}

function splitIntoRawRounds(events: ReadonlyArray<PartyEvent>): RawRound[] {
  // Defensive dedupe (eventSeq).
  const seenSeqs = new Set<string>();
  const deduped: PartyEvent[] = [];
  for (const ev of events) {
    const key = String(ev.eventSeq ?? '');
    if (key && seenSeqs.has(key)) continue;
    if (key) seenSeqs.add(key);
    deduped.push(ev);
  }

  // Sort by TIMESTAMP, not eventSeq. The daemon used to reset its
  // in-memory eventSeq counter on restart, which let new turns' events
  // overwrite earlier turns at the same seq (and silently destroy
  // content). That's fixed at the daemon now (loadMaxEventSeq seeds the
  // counter from DDB), but we keep this sort as a defensive belt-and-
  // suspenders so:
  //   (a) sessions damaged by the old bug still render in chronological
  //       order, and
  //   (b) any future seq glitch can't reorder rounds in the UI.
  // Events within the same millisecond fall back to eventSeq for stable
  // order — the daemon writes assistant tokens in tight bursts.
  const sorted = [...deduped].sort((a, b) => {
    const at = Date.parse(a.timestamp || '');
    const bt = Date.parse(b.timestamp || '');
    if (at !== bt) return at - bt;
    return String(a.eventSeq).localeCompare(String(b.eventSeq));
  });

  const rounds: RawRound[] = [];
  let current: RawRound | null = null;
  for (const ev of sorted) {
    if (ev.eventType === 'party.turn.user') {
      if (current) rounds.push(current);
      current = { startEvent: ev, events: [] };
    } else if (current) {
      current.events.push(ev);
    }
    // Events before the first user message are dropped (bootstrap noise).
  }
  if (current) rounds.push(current);
  return rounds;
}

/**
 * Story 21.5 — pick the last checkpoint event in a round (composed | pushed |
 * blocked | failed). When the daemon emits multiple (legacy + rewrite), the
 * latest one wins.
 */
function collectCheckpoint(events: ReadonlyArray<PartyEvent>): RoundCheckpoint | undefined {
  for (let i = events.length - 1; i >= 0; i--) {
    const ev = events[i] as PartyEvent & {
      title?: string;
      summary?: string;
      branch?: string;
      commitSha?: string | null;
      pushed?: boolean;
      reason?: string;
      exitCode?: number | null;
    };
    let kind: RoundCheckpoint['kind'] | null = null;
    if (ev.eventType === 'party.checkpoint.pushed') kind = 'pushed';
    else if (ev.eventType === 'party.checkpoint.composed') kind = 'composed';
    else if (ev.eventType === 'party.checkpoint.blocked') kind = 'blocked';
    else if (ev.eventType === 'party.checkpoint.failed') kind = 'failed';
    if (!kind) continue;
    return {
      kind,
      title: ev.title,
      summary: ev.summary,
      branch: ev.branch,
      commitSha: ev.commitSha ?? null,
      pushed: ev.pushed === true,
      reason: String(ev.reason ?? ''),
      exitCode: typeof ev.exitCode === 'number' ? ev.exitCode : null,
      timestamp: ev.timestamp || new Date().toISOString(),
    };
  }
  return undefined;
}

function collectTools(events: ReadonlyArray<PartyEvent>): ToolCall[] {
  const out: ToolCall[] = [];
  const seen = new Set<string>();
  for (const ev of events) {
    if (ev.eventType !== 'party.turn.assistant.tool') continue;
    const tool = (ev as { tool?: { id?: string; name?: string; input?: Record<string, unknown> } })
      .tool;
    if (!tool || !tool.name) continue;
    const id = tool.id ?? `${tool.name}-${out.length}`;
    if (seen.has(id)) continue;
    seen.add(id);
    out.push({
      id,
      name: tool.name,
      input: tool.input ?? {},
      timestamp: ev.timestamp,
    });
  }
  return out;
}

function deriveStatus(
  raw: RawRound,
  isLast: boolean,
  isProcessing: boolean,
): { status: RoundStatus; errorReason?: string } {
  // Look for terminal markers in this round's events.
  for (const ev of raw.events) {
    if (ev.eventType === 'party.turn.error') {
      return {
        status: 'error',
        errorReason: String((ev as { reason?: string }).reason ?? 'unknown'),
      };
    }
    if (ev.eventType === 'party.turn.awaiting_user') {
      return { status: 'awaiting' };
    }
  }
  const completed = raw.events.some((e) => e.eventType === 'party.turn.completed');
  if (completed) return { status: 'done' };
  if (isLast && isProcessing) return { status: 'active' };
  return { status: 'done' };
}

/**
 * Adapt the full event stream into rounds suitable for V2 rendering.
 *
 * `sessionStatus` is the session's top-level status (PROCESSING, ACTIVE, …).
 * It's needed to decide whether the *last* round is still streaming when no
 * `party.turn.completed` event has arrived yet.
 */
export function adaptSession(
  events: ReadonlyArray<PartyEvent>,
  sessionStatus?: string,
): AdaptedSession {
  const isProcessing = sessionStatus === 'PROCESSING';
  const raw = splitIntoRawRounds(events);
  const rounds: Round[] = raw.map((r, i) => {
    const isLast = i === raw.length - 1;
    const { status, errorReason } = deriveStatus(r, isLast, isProcessing);
    const text = mergeAssistantTokens(r.events);
    const blocks = parseTurn(text);
    const tools = collectTools(r.events);
    const checkpoint = collectCheckpoint(r.events);

    const speakers: string[] = [];
    for (const b of blocks) {
      if (b.kind === 'agent' && b.speaker && !speakers.includes(b.speaker)) {
        speakers.push(b.speaker);
      }
    }
    const turns = blocks.filter((b) => b.kind === 'agent').length;

    const userPayload = r.startEvent as { content?: string; timestamp?: string };
    return {
      id: `r-${i + 1}`,
      n: i + 1,
      status,
      startedAt: r.startEvent.timestamp || new Date().toISOString(),
      user: {
        text: userPayload.content ?? '',
        timestamp: r.startEvent.timestamp || new Date().toISOString(),
      },
      blocks,
      tools,
      speakers,
      turns,
      errorReason,
      isInflight: isLast && status === 'active',
      ...(checkpoint ? { checkpoint } : {}),
    };
  });

  const activeRoundId = rounds.length > 0 ? rounds[rounds.length - 1].id : null;
  return { rounds, activeRoundId, isProcessing };
}

/**
 * Find the currently-streaming agent for a round — i.e. the speaker of the
 * last agent block in the active round. Used to drive the typing indicator
 * and AvatarRail "current" highlight.
 */
export function currentSpeakerOf(round: Round | undefined): string | null {
  if (!round || !round.isInflight) return null;
  for (let i = round.blocks.length - 1; i >= 0; i--) {
    const b = round.blocks[i];
    if (b.kind === 'agent' && b.speaker) return b.speaker;
  }
  return null;
}

/**
 * Concise time-ago label suitable for round cards. Avoids pulling in a
 * heavy date library; date-fns is already in the bundle but this keeps the
 * adapter framework-free for tests.
 */
export function timeAgo(iso: string, now = Date.now()): string {
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return '';
  const sec = Math.max(0, Math.round((now - t) / 1000));
  if (sec < 30) return 'now';
  if (sec < 60) return `${sec}s ago`;
  const min = Math.round(sec / 60);
  if (min < 60) return `${min} min ago`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.round(hr / 24);
  return `${day}d ago`;
}
