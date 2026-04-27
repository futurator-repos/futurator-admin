// Pipeline v1 — Epic 3 (Talk-to-agent v1).
//
// `AgentSession` is one Claude conversation thread (a `claude --resume`-able
// session). `AgentConversation` is an operator-driven chat thread on top of
// a session — multiple conversations may attach to the same session over
// time (e.g. fork-debug a completed step), but only one can be OPEN at a
// time per session in v1.

export type SessionStatus = 'ACTIVE' | 'IDLE' | 'STALE' | 'ARCHIVED';
export type SessionWarmth = 'HOT' | 'WARM' | 'COLD' | 'STALE';
export type ConversationMode = 'fresh' | 'resume' | 'compact-resume';
export type ConversationStatus = 'OPEN' | 'APPLIED' | 'CLOSED';

/**
 * `AgentSession` — backing storage for a Claude session. PK: `sessionId`
 * (our internal UUID). The `claudeSessionId` matches the CLI's session for
 * `--resume`. GSI `jobId-stepId-index` lets the daemon look up an existing
 * session by (jobId, stepId).
 */
export interface AgentSession {
  sessionId: string;
  jobId: string;
  stepId: string;
  /** Set after the first turn lands and the CLI emits `system.init`. */
  claudeSessionId?: string;
  firstTurnAt?: string;
  lastTurnAt?: string;
  /** Story 5.1 — running token count across all turns. */
  tokenCount?: number;
  /** Story 4.1 — running cost across all turns. */
  costUsd?: number;
  status: SessionStatus;
  /** Working directory the session was spawned in (needed for resume). */
  cwd: string;
  /** Agent kind tag — used by Story 5.2's warmth chip + apply-output extractor lookup. */
  agentKind?: string;
  /** Story 5.3 — when this row replaces a compacted predecessor, points back. */
  compactedFrom?: string;
}

/**
 * `AgentConversation` — operator-driven chat thread layered over an
 * `AgentSession`. PK: `conversationId`. GSI `sessionId-index` to fetch the
 * conversations attached to a session.
 */
export interface AgentConversation {
  conversationId: string;
  sessionId: string;
  jobId: string;
  stepId: string;
  mode: ConversationMode;
  /** UserId from the JWT — single-user in v1 but field is reserved for multi. */
  openedBy: string;
  openedAt: string;
  lastActivityAt: string;
  status: ConversationStatus;
  messageCount: number;
  totalCostUsd: number;
  /** Story 3.6 — set when apply-output succeeded. */
  appliedToJobAt?: string;
  /** Story 4.3 — per-conversation cost cap; default $5. */
  costCeilingUsd: number;
  /**
   * Story 3.4 — system prompt source for `mode=fresh` conversations.
   * Templated handoff string; empty for resume / compact-resume.
   */
  systemPromptSource?: string;
}
