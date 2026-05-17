/**
 * free-agent.ts — Story 18.2 (Epic 18: Free Claude Code Agent)
 *
 * Type definitions for the free-agent session runtime. The session row is
 * persisted in `futurator-free-agent-sessions`; the conversation messages
 * (separate table introduced in Story 18.6) reference rows here by sessionId.
 *
 * State machine (driven by daemon + GC):
 *
 *   created → ACTIVE → PROCESSING ──(turn complete)──→ ACTIVE
 *                  │                                   │
 *                  ├──(GC: 30min idle)───────────────→ IDLE
 *                  │                                   │
 *                  │                                   └──(GC: +2h)──→ EXPIRED
 *                  │                                                      │
 *                  │                                                      └──(7d)→ worktree reap (Story 18.1 GC)
 *                  │
 *                  ├──(cost-cap exit)──→ BUDGET_EXHAUSTED
 *                  │
 *                  └──(timeout / non-zero exit)──→ ERROR
 *
 * A new message to an EXPIRED session creates a *new* session row (forks);
 * the prior conversation persists in DDB for history via the conversations table.
 */

export type FreeAgentSessionStatus =
  | 'ACTIVE'
  | 'PROCESSING'
  | 'IDLE'
  | 'EXPIRED'
  | 'BUDGET_EXHAUSTED'
  | 'ERROR';

export type FreeAgentScopeKind = 'project' | 'plan' | 'app' | 'workspace';

export interface FreeAgentScope {
  kind: FreeAgentScopeKind;
  /** Required for project/plan/app; absent (or '_') for workspace scope. */
  id?: string;
}

/** Three labeled options surfaced in the v1 UI; raw strings also accepted. */
export type ModelAlias = 'haiku' | 'sonnet' | 'opus';

export interface FreeAgentSession {
  sessionId: string;
  operatorId: string;
  projectId: string;
  scope: FreeAgentScope;
  /** GSI2 partition key: `${scope.kind}#${scope.id ?? '_'}`. Stored for direct query. */
  scopeIdComposite: string;
  status: FreeAgentSessionStatus;
  /** Model alias or full model id (e.g., `claude-sonnet-4-6`). */
  model: string;
  costCapUsd: number;
  costUsdAccumulated: number;
  /** Story 18.3 — cumulative input-equivalent tokens (sum of input + cache_creation + cache_read across turns). */
  tokensInAccumulated?: number;
  /** Story 18.3 — cumulative output tokens across turns. */
  tokensOutAccumulated?: number;
  /** Captured from the first turn's stream-json `system.init` event. */
  claudeSessionId?: string;
  turnCount: number;
  /** ISO-8601 UTC. */
  createdAt: string;
  /** ISO-8601 UTC; updated on every turn + GC visit. */
  lastActivityAt: string;
  /** ISO-8601 UTC; set on first completed turn, then per-turn. */
  lastTurnAt?: string;
  /** ISO-8601 UTC; set when STS credentials were last refreshed via re-AssumeRole. */
  lastRefreshedAt?: string;
  /** Epoch seconds — DynamoDB TTL attribute. createdAt + 90d. */
  expiresAt: number;
  /** Set when status transitions to ERROR. */
  errorReason?: string;
}

/** Input to `createSession`. Most fields are derived inside the repo. */
export interface CreateFreeAgentSessionInput {
  sessionId: string;
  operatorId: string;
  projectId: string;
  scope: FreeAgentScope;
  model: string;
  costCapUsd: number;
}

/** Result of `acquireProcessingLock`. */
export type FreeAgentLockResult =
  | { ok: true }
  | { ok: false; reason: 'SESSION_BUSY' | 'NOT_FOUND' | 'INVALID_STATE' };

/** Subset of FreeAgentSessionStatus that releaseProcessingLock accepts as the next state. */
export type FreeAgentReleaseStatus = 'ACTIVE' | 'ERROR' | 'BUDGET_EXHAUSTED' | 'IDLE';

/** Build the GSI2 composite key from a scope. Exported for reuse by callers. */
export function buildScopeIdComposite(scope: FreeAgentScope): string {
  return `${scope.kind}#${scope.id ?? '_'}`;
}
