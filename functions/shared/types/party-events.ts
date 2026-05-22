/**
 * Story 22.1 (party-push Epic 22) — PartyEvent discriminated union.
 *
 * Strongly-typed event payloads for the party.* event family. Per
 * Free Explorer §9.1 Q4 #7 ("type the events from day one"), this gives:
 *   - Compile-time exhaustiveness for renderers + audit consumers
 *   - A single place to document each event's payload contract
 *   - A migration target for the loose `payload: Record<string, unknown>`
 *     shape on `PartyEvent` in party.ts (which stays as the DDB row
 *     shape — the discriminated union is the parsed/typed view).
 *
 * Convention: each variant carries `type` (eventType) + the minimum
 * payload fields a UI renderer or audit consumer needs. Optional fields
 * are explicit; unknown fields are preserved by the underlying
 * `payload: Record<string, unknown>` until a callsite needs them.
 *
 * Callers that need the typed view convert via `parsePartyEvent(rawEvent)`.
 */

import type { PartyEvent as RawPartyEvent } from './party';

// ── Checkpoint events (Story 21.4) ───────────────────────────────────

/** Common fields all four checkpoint variants carry. */
export interface CheckpointEventBase {
  sessionId: string;
  projectId: string;
  branch: string;
  round: number;
  title?: string;
  summary?: string;
  commitSha: string | null;
  pushed: boolean;
  exitCode: number | null;
  reason: string;
}

/** Commit landed locally; push was gated off (project.pushEnabled=false). */
export interface CheckpointComposedEvent extends CheckpointEventBase {
  type: 'party.checkpoint.composed';
}

/** Commit landed AND was pushed to GitHub (project.pushEnabled=true). */
export interface CheckpointPushedEvent extends CheckpointEventBase {
  type: 'party.checkpoint.pushed';
}

/** Secrets scan blocked the commit. */
export interface CheckpointBlockedEvent extends CheckpointEventBase {
  type: 'party.checkpoint.blocked';
}

/** Non-zero exit from party-checkpoint.sh that isn't secrets-blocked. */
export interface CheckpointFailedEvent extends CheckpointEventBase {
  type: 'party.checkpoint.failed';
}

// ── ASK_HUMAN (Story 20.7) ───────────────────────────────────────────

export interface AgentQuestionEvent {
  type: 'party.agent.question';
  sessionId: string;
  question: string;
  turnCount: number;
}

// ── Tool default-allow audit (Story 20.3) ────────────────────────────

export interface ToolDefaultAllowEvent {
  type: 'party.tool.default-allow';
  sessionId?: string;
  command: string;
  jobId?: string;
}

// ── Union ────────────────────────────────────────────────────────────

export type TypedPartyEvent =
  | CheckpointComposedEvent
  | CheckpointPushedEvent
  | CheckpointBlockedEvent
  | CheckpointFailedEvent
  | AgentQuestionEvent
  | ToolDefaultAllowEvent;

/**
 * Best-effort parse from a raw DDB PartyEvent to a typed variant.
 * Returns null when the event type is not in the typed union (the caller
 * should fall back to the raw shape for legacy / less-structured events).
 *
 * No throwing — the union types are a UI/audit affordance, not a security
 * boundary. Missing fields fall through as undefined and the caller's
 * renderer is responsible for tolerating them (commitSha can be null
 * before the script runs; pushed can be false; etc).
 */
export function parsePartyEvent(raw: RawPartyEvent): TypedPartyEvent | null {
  const t = raw.eventType;
  const p = raw.payload as Record<string, unknown>;
  switch (t) {
    case 'party.checkpoint.composed':
    case 'party.checkpoint.pushed':
    case 'party.checkpoint.blocked':
    case 'party.checkpoint.failed': {
      return {
        type: t,
        sessionId: String(p.sessionId ?? ''),
        projectId: String(p.projectId ?? ''),
        branch: String(p.branch ?? ''),
        round: Number(p.round ?? 0),
        title: p.title != null ? String(p.title) : undefined,
        summary: p.summary != null ? String(p.summary) : undefined,
        commitSha: typeof p.commitSha === 'string' ? p.commitSha : null,
        pushed: p.pushed === true,
        exitCode: typeof p.exitCode === 'number' ? p.exitCode : null,
        reason: String(p.reason ?? ''),
      };
    }
    case 'party.agent.question':
      return {
        type: 'party.agent.question',
        sessionId: String(p.sessionId ?? ''),
        question: String(p.question ?? ''),
        turnCount: Number(p.turnCount ?? 0),
      };
    case 'party.tool.default-allow':
      return {
        type: 'party.tool.default-allow',
        sessionId: p.sessionId != null ? String(p.sessionId) : undefined,
        command: String(p.command ?? ''),
        jobId: p.jobId != null ? String(p.jobId) : undefined,
      };
    default:
      return null;
  }
}

/** Type guard: is this raw event one of the checkpoint variants? */
export function isCheckpointEvent(raw: RawPartyEvent): boolean {
  return (
    raw.eventType === 'party.checkpoint.composed' ||
    raw.eventType === 'party.checkpoint.pushed' ||
    raw.eventType === 'party.checkpoint.blocked' ||
    raw.eventType === 'party.checkpoint.failed'
  );
}
