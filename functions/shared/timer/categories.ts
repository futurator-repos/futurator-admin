// Timer Intelligence — classification table (Story 1.8.1)
// One declarative entry per (AgentEventType × AgentRole) pair.
// Consumed exclusively by classifier.ts — do not import elsewhere.
import type { AgentEventType, AgentRole } from '../types/agent-orchestrator';
import type { TimerCategory } from './types';

/**
 * Three-tier resolution for each event type:
 *   1. role-specific overrides  (exact match on agentRole string)
 *   2. default category          (role not in overrides — the most common mapping)
 *
 * Ordering of overrides does not matter; classifier iterates the Map.
 */
export interface EventClassification {
  /** Category when agentRole matches one of the override keys. */
  byRole?: Partial<Record<AgentRole | string, TimerCategory>>;
  /** Category when agentRole does not match any override — or when byRole is absent. */
  default: TimerCategory;
}

/**
 * Primary classification table.
 *
 * Every value of `AgentEventType` has exactly one entry.
 * The classifier performs an exhaustive switch to guarantee compile-time
 * coverage (adding a new enum value without updating this table → build fails).
 *
 * Reasoning for each deliberate choice is documented inline.
 */
export const CLASSIFICATION_TABLE: Record<AgentEventType, EventClassification> = {
  // ── Streaming agent output ──────────────────────────────────────────────
  // text_delta is the agent "thinking out loud". Route by role:
  //   reviewer  → review
  //   dev (0 retries) → dev
  //   dev (retries)   → fix  [handled in classifier.ts via retryCount]
  //   orchestrator    → compile (planning thoughts, not deliverable work)
  //   unknown role    → dev  (most common agent)
  text_delta: {
    byRole: {
      reviewer: 'review',
      orchestrator: 'compile',
    },
    default: 'dev',
  },

  // ── Tool invocations ─────────────────────────────────────────────────────
  // Reviewer using tools (e.g. reading files) is still review time.
  // Orchestrator using tools is compile/planning.
  // Dev using tools is dev (or fix on retry — classifier adjusts).
  tool_use: {
    byRole: {
      reviewer: 'review',
      orchestrator: 'compile',
    },
    default: 'dev',
  },

  // tool_result mirrors tool_use — it's the same work window, just the reply.
  tool_result: {
    byRole: {
      reviewer: 'review',
      orchestrator: 'compile',
    },
    default: 'dev',
  },

  // ── Final agent result (terminal turn output) ─────────────────────────────
  // result is emitted once per Claude session turn when the model finishes.
  result: {
    byRole: {
      reviewer: 'review',
      orchestrator: 'compile',
    },
    default: 'dev',
  },

  // ── Daemon status updates ─────────────────────────────────────────────────
  // 'status' events are daemon-emitted heartbeats / phase transitions:
  // the pipeline is active but the agent hasn't produced tokens yet (warm-up,
  // context loading). This is machine overhead, not dev work.
  status: {
    default: 'machine-wait',
  },

  // ── Step lifecycle (pipeline machinery) ──────────────────────────────────
  // step_start / step_complete are pure pipeline plumbing — no agent token produced.
  step_start: {
    default: 'compile',
  },

  step_complete: {
    default: 'compile',
  },

  // step_error signals a step failure; the pipeline is now in recovery mode.
  step_error: {
    default: 'fix',
  },

  // ── Extraction / validation (post-turn processing) ────────────────────────
  // Both run after the agent turn completes to parse output and check conditions.
  // They are orchestrator/pipeline overhead — no new agent tokens.
  extraction: {
    default: 'compile',
  },

  validation: {
    default: 'compile',
  },

  // ── Explicit compilation events ───────────────────────────────────────────
  'compilation-started': {
    default: 'compile',
  },

  'compilation-completed': {
    default: 'compile',
  },

  // compilation-failed initiates recovery — classify as fix.
  'compilation-failed': {
    default: 'fix',
  },

  // ── Epic-dev orchestrator lifecycle ──────────────────────────────────────
  // These are orchestrator-level bookmarks, structurally near-zero duration
  // (the slicer in Story 1.8.2 downgrades to 'idle' when durationMs < 500).
  // The classifier returns 'compile' unconditionally; the slicer applies the
  // 500 ms heuristic to produce 'idle'. We never set 'idle' here because the
  // classifier has no durationMs; it only sees the event shape.
  epic_start: {
    default: 'compile',
  },

  epic_complete: {
    default: 'compile',
  },

  // epic_failed — same treatment; orchestrator is wrapping up.
  epic_failed: {
    default: 'compile',
  },

  wave_start: {
    default: 'compile',
  },

  wave_complete: {
    default: 'compile',
  },

  // wave_split / wave_collision are wave-planning decisions by the orchestrator.
  wave_split: {
    default: 'compile',
  },

  wave_collision: {
    default: 'compile',
  },

  // ── Sub-agent dispatch / return ───────────────────────────────────────────
  // These bracket the time the orchestrator is waiting for a child process.
  // The time between dispatch and return is machine-wait (awaiting subprocess).
  subagent_dispatch: {
    default: 'machine-wait',
  },

  subagent_return: {
    default: 'machine-wait',
  },

  // ── Blocker lifecycle ─────────────────────────────────────────────────────
  // dev_blocker_reported / story_blocked: a story cannot proceed without human
  // intervention. The span from this event until resolution is human-wait.
  // (Note: the NEEDS_ATTENTION cross-cut in classifier.ts also covers the
  //  job-level human-wait. These event-level entries handle the case where
  //  individual stories are blocked within an otherwise-RUNNING epic-dev job.)
  dev_blocker_reported: {
    default: 'human-wait',
  },

  story_blocked: {
    default: 'human-wait',
  },

  // blocker_resolved — orchestrator machinery; plan resumes.
  blocker_resolved: {
    default: 'compile',
  },

  // ── Context / touch-point inference ──────────────────────────────────────
  // These events are emitted by the orchestrator's inference pass (Epic 3).
  // They are planning overhead — no agent deliverable produced.
  touch_points_expanded: {
    default: 'compile',
  },

  context_expanded: {
    default: 'compile',
  },

  // ── Review verdict ────────────────────────────────────────────────────────
  // review_verdict is always emitted by the reviewer agent.
  // Force 'review' regardless of the role field (which should be 'reviewer').
  review_verdict: {
    default: 'review',
  },

  // ── Remediation ───────────────────────────────────────────────────────────
  // remediation_start marks the beginning of a fix-loop iteration.
  remediation_start: {
    default: 'fix',
  },

  // story_failed_terminally — the story gave up; orchestrator records the outcome.
  // Classify as fix (it's the end of a failed remediation chain, not idle time).
  story_failed_terminally: {
    default: 'fix',
  },

  // ── Touch-point inference (Epic 3) ───────────────────────────────────────
  inference_start: {
    default: 'compile',
  },

  story_inferred: {
    default: 'compile',
  },

  // wave_conflict_autosplit — auto-split during inference; orchestrator planning.
  wave_conflict_autosplit: {
    default: 'compile',
  },

  inference_failed: {
    default: 'fix',
  },

  inference_complete: {
    default: 'compile',
  },
};

/**
 * Roles whose primary work events (text_delta, tool_use, tool_result, result)
 * shift from 'dev' to 'fix' when retryCount > 0.
 *
 * 'reviewer' is excluded: even on a retry, reviewing is reviewing.
 * 'orchestrator' is excluded: even on a retry, orchestrating is compiling.
 */
export const FIX_ELIGIBLE_ROLES: ReadonlySet<string> = new Set(['dev']);

/**
 * Event types whose default category shifts to 'fix' when `retryCount > 0`
 * AND the role is in `FIX_ELIGIBLE_ROLES`.
 */
export const FIX_ON_RETRY_EVENT_TYPES: ReadonlySet<AgentEventType> = new Set<AgentEventType>([
  'text_delta',
  'tool_use',
  'tool_result',
  'result',
]);
