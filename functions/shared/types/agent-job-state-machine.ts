import type { AgentJobStatus } from './agent-orchestrator';

/**
 * Agent-job state machine — Pipeline v1, Epic 1 / Story 1.1.
 *
 * Single source of truth for which statuses are terminal, which count as
 * success for wave/plan advancement, and which legal transitions exist.
 * Reducers (`wave-reducer`, `plan-reducer`) and the daemon's terminal-write
 * sites MUST go through these helpers — never inline membership checks
 * against the enum, because new states (NEEDS_ATTENTION, COMPLETED_VIA_SALVAGE,
 * MANUALLY_SKIPPED) have non-obvious advancement semantics.
 *
 * State diagram:
 *
 *   PENDING ──→ RUNNING ──→ COMPLETED                     [success]
 *                       ──→ COMPLETE_WITH_BLOCKED_STORIES  [success — epic-dev]
 *                       ──→ FAILED                         [terminal failure]
 *                       ──→ STALE                          [terminal — heartbeat lost]
 *                       ──→ NEEDS_ATTENTION                [paused, awaiting operator]
 *
 *   NEEDS_ATTENTION ──→ COMPLETED_VIA_SALVAGE              [Salvage — terminal success]
 *                   ──→ MANUALLY_SKIPPED                   [Skip — terminal, advances wave]
 *                   ──→ FAILED                             [Abort — terminal failure]
 *                   (Retry creates a NEW job; original stays NEEDS_ATTENTION.)
 */

/** Statuses where a job will not transition further on its own. */
const TERMINAL_STATUSES: ReadonlySet<AgentJobStatus> = new Set([
  'COMPLETED',
  'FAILED',
  'COMPLETE_WITH_BLOCKED_STORIES',
  'STALE',
  'COMPLETED_VIA_SALVAGE',
  'COMPLETED_VIA_TALK',
  'MANUALLY_SKIPPED',
]);

/**
 * Statuses that count as "the wave can advance past this story." Salvage,
 * Talk-apply, and Skip are explicit operator decisions to move forward, so
 * they advance the wave even though they aren't a clean COMPLETED.
 */
const SUCCESS_STATUSES: ReadonlySet<AgentJobStatus> = new Set([
  'COMPLETED',
  'COMPLETE_WITH_BLOCKED_STORIES',
  'COMPLETED_VIA_SALVAGE',
  'COMPLETED_VIA_TALK',
  'MANUALLY_SKIPPED',
]);

/**
 * NEEDS_ATTENTION is *not* terminal — it pauses the wave waiting for an
 * operator action that will then move the job to one of the terminal states
 * above (or spawn a new job via Retry). Reducers must treat NEEDS_ATTENTION
 * as "paused, do not advance, do not propagate to siblings."
 */
const PAUSED_STATUSES: ReadonlySet<AgentJobStatus> = new Set(['NEEDS_ATTENTION']);

/** Pre-terminal statuses where the daemon may still be doing work. */
const ACTIVE_STATUSES: ReadonlySet<AgentJobStatus> = new Set(['PENDING', 'RUNNING']);

export function isTerminal(status: AgentJobStatus): boolean {
  return TERMINAL_STATUSES.has(status);
}

export function isSuccess(status: AgentJobStatus): boolean {
  return SUCCESS_STATUSES.has(status);
}

export function isFailureTerminal(status: AgentJobStatus): boolean {
  return TERMINAL_STATUSES.has(status) && !SUCCESS_STATUSES.has(status);
}

export function isPaused(status: AgentJobStatus): boolean {
  return PAUSED_STATUSES.has(status);
}

export function isActive(status: AgentJobStatus): boolean {
  return ACTIVE_STATUSES.has(status);
}

/**
 * Allowed transitions per the state diagram above. Returns true if the
 * status mutation is legal. Reducers/APIs may enforce this at write time;
 * tests assert the table.
 */
const ALLOWED_TRANSITIONS: Record<AgentJobStatus, ReadonlySet<AgentJobStatus>> = {
  PENDING: new Set<AgentJobStatus>(['RUNNING', 'FAILED']),
  RUNNING: new Set<AgentJobStatus>([
    'COMPLETED',
    'COMPLETE_WITH_BLOCKED_STORIES',
    'FAILED',
    'STALE',
    'NEEDS_ATTENTION',
  ]),
  NEEDS_ATTENTION: new Set<AgentJobStatus>([
    'COMPLETED_VIA_SALVAGE',
    'COMPLETED_VIA_TALK',
    'MANUALLY_SKIPPED',
    'FAILED',
  ]),
  // Terminal — no outbound transitions.
  COMPLETED: new Set<AgentJobStatus>(),
  COMPLETE_WITH_BLOCKED_STORIES: new Set<AgentJobStatus>(),
  FAILED: new Set<AgentJobStatus>(),
  STALE: new Set<AgentJobStatus>(['PENDING']), // resume respawn re-enqueues a new attempt
  COMPLETED_VIA_SALVAGE: new Set<AgentJobStatus>(),
  COMPLETED_VIA_TALK: new Set<AgentJobStatus>(),
  MANUALLY_SKIPPED: new Set<AgentJobStatus>(),
};

export function canTransition(from: AgentJobStatus, to: AgentJobStatus): boolean {
  return ALLOWED_TRANSITIONS[from].has(to);
}
