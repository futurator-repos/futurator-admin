// Timer Intelligence — pure event classifier (Story 1.8.1)
// classify(event, jobContext) → TimerCategory  (no I/O, no side effects)
import type { AgentEvent, AgentEventType } from '../types/agent-orchestrator';
import { CLASSIFICATION_TABLE, FIX_ELIGIBLE_ROLES, FIX_ON_RETRY_EVENT_TYPES } from './categories';
import type { JobContext, TimerCategory } from './types';

/**
 * Compile-time exhaustiveness guard.
 * If a new `AgentEventType` value is added without a corresponding entry in
 * `CLASSIFICATION_TABLE` (and therefore without a case in the switch below),
 * TypeScript will error here — Gate G-5.
 */
function assertNever(x: never): never {
  throw new Error(`Unhandled AgentEventType in classifier: ${String(x)}`);
}

/**
 * Resolve the base category from the classification table.
 *
 * The switch enforces exhaustiveness at compile time: every `AgentEventType`
 * value must appear as a case. This is the single place where adding a new
 * event type breaks the build until the classifier is updated.
 */
function lookupTable(eventType: AgentEventType): TimerCategory {
  const row = CLASSIFICATION_TABLE[eventType];

  // Validate that the table is fully populated (runtime defence, belt-and-suspenders).
  if (!row) {
    return 'unattributed';
  }

  // The switch is deliberately exhaustive — each case just confirms the row exists
  // and lets the compiler track coverage. The actual mapping is in CLASSIFICATION_TABLE.
  switch (eventType) {
    case 'text_delta':
    case 'tool_use':
    case 'tool_result':
    case 'result':
    case 'status':
    case 'step_start':
    case 'step_complete':
    case 'step_error':
    case 'extraction':
    case 'validation':
    case 'compilation-started':
    case 'compilation-completed':
    case 'compilation-failed':
    case 'epic_start':
    case 'epic_complete':
    case 'epic_failed':
    case 'wave_start':
    case 'wave_complete':
    case 'wave_split':
    case 'wave_collision':
    case 'subagent_dispatch':
    case 'subagent_return':
    case 'dev_blocker_reported':
    case 'story_blocked':
    case 'blocker_resolved':
    case 'touch_points_expanded':
    case 'context_expanded':
    case 'review_verdict':
    case 'remediation_start':
    case 'story_failed_terminally':
    case 'inference_start':
    case 'story_inferred':
    case 'wave_conflict_autosplit':
    case 'inference_failed':
    case 'inference_complete':
      return row.default; // role override applied in classify() below
    default:
      // Pipeline v2.0 PR-6 (F) — runtime resilience.
      // The compile-time exhaustiveness check still runs (TypeScript narrows
      // `eventType` to `never` here), but at runtime DDB rows may contain
      // legacy or unknown event types from prior schema versions or external
      // emitters. Falling through to 'unattributed' instead of throwing
      // assertNever fixes the timing API 500 we observed when an event row
      // had an unrecognized eventType. The void-cast keeps the
      // exhaustiveness check on by suppressing the unused-var warning while
      // we silently classify unknown events as 'unattributed'.
      void (eventType as never);
      return 'unattributed';
  }
}

/**
 * Classify a single `AgentEvent` into a `TimerCategory`.
 *
 * Resolution order (first matching rule wins):
 *
 *   1. NEEDS_ATTENTION cross-cut
 *      Any event emitted while the job is in NEEDS_ATTENTION is 'human-wait'.
 *      The operator must act before the job can advance; all time in this
 *      window is human-wait regardless of which event fires.
 *
 *   2. Role-specific override from CLASSIFICATION_TABLE
 *      E.g. text_delta + role=reviewer → 'review'.
 *
 *   3. Fix-on-retry promotion
 *      For roles in FIX_ELIGIBLE_ROLES (currently only 'dev'), events in
 *      FIX_ON_RETRY_EVENT_TYPES (text_delta, tool_use, tool_result, result)
 *      shift from 'dev' to 'fix' when retryCount > 0. This detects that the
 *      agent is iterating on a previous failure rather than doing fresh work.
 *
 *   4. Table default
 *      The event type's default category from CLASSIFICATION_TABLE.
 *
 *   5. Unattributed fallback
 *      Should never be reached with a fully-populated table, but exists as the
 *      honesty bucket. Gate G-5 asserts this stays empty in CI.
 *
 * Note on 'idle': the classifier never emits 'idle'. That category is reserved
 * for the Slicer (Story 1.8.2) which downgrades 'compile' slices to 'idle'
 * when durationMs < 500. The classifier lacks durationMs.
 *
 * Note on 'human-wait' spanning NEEDS_ATTENTION → terminal: the Slicer
 * (Story 1.8.2) is responsible for extending the human-wait span across
 * all events emitted while jobStatus remains NEEDS_ATTENTION. It achieves
 * this by passing an updated JobContext (with jobStatus='NEEDS_ATTENTION')
 * for every event in that window — no special logic required here.
 */
export function classify(event: AgentEvent, jobContext: JobContext): TimerCategory {
  const { agentRole, jobStatus, retryCount } = jobContext;
  const eventType = event.eventType;

  // Rule 1 — NEEDS_ATTENTION cross-cut
  if (jobStatus === 'NEEDS_ATTENTION') {
    return 'human-wait';
  }

  // Validate the event type is in the table (forward-compat: a new event type
  // emitted by a newer daemon version before the classifier is updated will
  // fall through to 'unattributed' gracefully instead of crashing).
  const row = CLASSIFICATION_TABLE[eventType as AgentEventType];
  if (!row) {
    return 'unattributed';
  }

  // Rule 2 — Role-specific override
  const roleCategory = row.byRole?.[agentRole];
  if (roleCategory !== undefined) {
    return roleCategory;
  }

  // Rule 3 — Fix-on-retry promotion (only for fix-eligible roles + fix-eligible event types)
  if (
    retryCount > 0 &&
    FIX_ELIGIBLE_ROLES.has(agentRole) &&
    FIX_ON_RETRY_EVENT_TYPES.has(eventType as AgentEventType)
  ) {
    return 'fix';
  }

  // Rule 4 — Table default (enforced-exhaustive lookup via switch)
  // Cast is safe: if eventType is in the table (checked above), it's AgentEventType.
  return lookupTable(eventType as AgentEventType);
}
