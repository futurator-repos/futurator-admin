// Timer Intelligence — shared types (Story 1.8.1)
// Consumed by: classifier.ts, categories.ts, slicer.ts (Story 1.8.2), aggregator.ts
import type { AgentJobStatus, AgentRole } from '../types/agent-orchestrator';

/**
 * The 15-bucket MECE taxonomy for agent time.
 *
 * - dev           Agent (role=dev) reading/writing code; primary work.
 * - test-author   Agent authoring test files (future: role=test-author).
 * - test-execute  Shell step running a test suite (future: shell step with test command).
 * - review        Agent (role=reviewer) evaluating output — text_delta, tool_use, result.
 * - qa            Dedicated QA agent (future role). Reserved for Phase 2.
 * - po            Product-owner / spec-clarification agent. Reserved for Phase 2.
 * - architect     ARCHITECT agent pass (Phase 2). Reserved.
 * - compile       Orchestrator machinery: wave/step lifecycle, extraction, validation,
 *                 inference, context-expansion. Does not advance deliverable directly.
 * - human-wait    Time the job is paused waiting for operator action (NEEDS_ATTENTION
 *                 or explicit human-wait events like dev_blocker_reported / story_blocked).
 * - machine-wait  Time waiting for a subprocess/subagent to respond or be dispatched
 *                 (subagent_dispatch, subagent_return, status events).
 * - git           Git operations: commit, push, clone (future shell steps tagged 'git').
 * - bootstrap     App/BMAD bootstrap steps (future: job-kind=app-bootstrap events).
 * - fix           Remediation work: retryCount > 0 dev activity, remediation_start,
 *                 compilation-failed, inference_failed, story_failed_terminally, step_error.
 * - idle          Very short orchestrator lifecycle events (<500 ms by convention) — the
 *                 Slicer applies the 500 ms heuristic; the classifier emits 'idle' for
 *                 lifecycle events that structurally carry near-zero duration (epic_start,
 *                 wave_start, wave_complete, epic_complete) only when the slicer overrides
 *                 via duration. The classifier alone always emits 'compile' for these;
 *                 Story 1.8.2 (slicer) downgrades to 'idle' when durationMs < 500.
 * - unattributed  Honesty bucket — events the table does not cover. Gate G-5 in CI
 *                 asserts this stays empty across a real plan run. If you see this in
 *                 production, add an explicit row to the classification table.
 */
export type TimerCategory =
  | 'dev'
  | 'test-author'
  | 'test-execute'
  | 'review'
  | 'qa'
  | 'po'
  | 'architect'
  | 'compile'
  | 'human-wait'
  | 'machine-wait'
  | 'git'
  | 'bootstrap'
  | 'fix'
  | 'idle'
  | 'unattributed';

/**
 * Minimal per-job context that the classifier needs alongside the event.
 * All four fields are required; the classifier uses combinations of them.
 *
 * - jobKind      The job's `jobType` string (e.g. 'party-bootstrap', 'agent-turn')
 *                or 'pipeline' for legacy per-step pipeline jobs.
 * - agentRole    The role of the agent emitting the event. May be an `AgentRole`
 *                literal or a raw string for forward-compat with Phase-2 roles
 *                (e.g. 'architect', 'qa').
 * - jobStatus    DynamoDB status at the time of classification. Events emitted
 *                while jobStatus === 'NEEDS_ATTENTION' are always 'human-wait'.
 * - retryCount   Number of retry attempts preceding this job (0 = first attempt).
 *                A value > 0 shifts dev tool_use / text_delta / tool_result / result
 *                from 'dev' to 'fix'.
 */
export interface JobContext {
  jobKind: string;
  agentRole: AgentRole | string;
  jobStatus: AgentJobStatus;
  retryCount: number;
}

/**
 * One time slice emitted by the Slicer (Story 1.8.2).
 * Declared here because the classifier's output type (`TimerCategory`) is a
 * field on this interface, and consumers import both from the `timer/` module.
 */
export interface TimerSlice {
  jobId: string;
  eventSeq: string;
  category: TimerCategory;
  startedAt: string; // ISO-8601
  endedAt: string; // ISO-8601
  durationMs: number;
  agentRole: string;
  eventType: string;
  /**
   * True only for the trailing slice emitted for a non-terminal job (live tail).
   * The slice spans the last event → Date.now() and its duration grows until the
   * job reaches a terminal state. Absent (or false) for all historical slices.
   */
  isLive?: boolean;
}
