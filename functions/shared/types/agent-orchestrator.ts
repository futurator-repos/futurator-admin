// ── Job status ──
//
// State machine (Pipeline v1 — Epic 1, Story 1.1):
//
//   PENDING → RUNNING → COMPLETED                         (happy path)
//                     → FAILED                            (only via Abort, or unrecoverable infra error)
//                     → COMPLETE_WITH_BLOCKED_STORIES     (epic-dev: non-blocker stories APPROVED)
//                     → STALE                             (epic-dev heartbeat lost; awaits resume respawn)
//                     → NEEDS_ATTENTION                   (recoverable failure — escalation, loop, preflight, ceiling, etc.)
//
//   NEEDS_ATTENTION → COMPLETED_VIA_SALVAGE               (operator Salvage)
//                   → MANUALLY_SKIPPED                    (operator Skip; pipeline step must be skipTolerant)
//                   → FAILED                              (operator Abort)
//                   (Retry creates a NEW job with retryOf=originalJobId; original stays NEEDS_ATTENTION.)
//
// Authoritative classification helpers live in `agent-job-state-machine.ts`.
// Wave/plan reducers MUST go through those helpers — never inline membership checks.

export type AgentJobStatus =
  | 'PENDING'
  | 'RUNNING'
  | 'COMPLETED'
  | 'FAILED'
  | 'COMPLETE_WITH_BLOCKED_STORIES' // epic-dev: non-blocker stories all APPROVED; blockers remain
  | 'STALE' // epic-dev: heartbeat exceeded threshold, awaiting resume respawn
  | 'NEEDS_ATTENTION' // recoverable failure; awaiting operator action (Pipeline v1 §8)
  | 'COMPLETED_VIA_SALVAGE' // terminal success: extracted output applied without re-running the agent
  | 'COMPLETED_VIA_PREWORK' // Pipeline v2.0 T0.2: daemon-side gate verified the AC was already
  // satisfied (recent commits + named exports + tsc clean) BEFORE spawning DEV.
  // Terminal success; no LLM was invoked. Wave/plan reducers treat this like
  // any other COMPLETED_VIA_* status.
  | 'MANUALLY_SKIPPED'; // terminal: operator skipped a skipTolerant step

// ── Escalation + trigger metadata (Pipeline v1 §9.2 + §FR-9) ──

/**
 * Triggered-by enum identifies why a job transitioned to NEEDS_ATTENTION (or
 * FAILED via Abort). Surfaced verbatim on attention items and the failed-step
 * panel. Values are added incrementally as each consuming story lands:
 *
 *   - 'AGENT_ESCALATED'   — Story 1.2 (---ESCALATE--- protocol)
 *   - 'AGENT_NEEDS_HUMAN' — Story 1.2 (---NEED-HUMAN--- protocol)
 *   - 'LOOP_DETECTED'     — Story 1.3 (loop detector forced exit)
 *   - 'PREFLIGHT_FAILED'  — Story 1.4 (validator failure pre-spawn)
 *   - 'POSTVALIDATE_FAILED' — Story 1.4-adjacent (post-step validator)
 *   - 'COST_CEILING'      — Story 4.3 (cost cap hit)
 *   - 'TIME_CEILING'      — Story 4.2 (wall-clock cap hit)
 *   - 'QUOTA_EXHAUSTED'   — Story 2.3 (Anthropic 429 daily/monthly)
 *   - 'CAPACITY_TIMEOUT'  — Story 2.1 (slot acquisition timeout)
 *   - 'RETRY_EXHAUSTED'   — pre-existing daemon retry ladder cap
 *   - 'DEV_RETRY_BUDGET_EXHAUSTED' — Pipeline v2.0 T0.3 (story-pipeline-
 *      specific budget; tighter than the generic ladder to bound waste on
 *      no-op DEV loops — see docs/concepts/pipeline-v2/pipeline-v2-0-
 *      efficency-fixes.md §T0.3)
 *   - 'AUTH_RECOVERY_EXHAUSTED' — Pipeline v2.0 PR-6 (B+): daemon attempted
 *      2 OAuth reloads after mid-stream auth failure; access token still
 *      invalid. Job lands in NEEDS_ATTENTION (not FAILED) so operator can
 *      Re-Authorize + click Retry; resume-from-session (PR-6 A) picks up
 *      where the agent left off.
 *   - 'OPERATOR_ABORT'    — Story 1.8 (manual Abort from UI)
 */
export type JobTriggeredBy =
  | 'AGENT_ESCALATED'
  | 'AGENT_NEEDS_HUMAN'
  | 'LOOP_DETECTED'
  | 'PREFLIGHT_FAILED'
  | 'POSTVALIDATE_FAILED'
  | 'COST_CEILING'
  | 'TIME_CEILING'
  | 'QUOTA_EXHAUSTED'
  | 'CAPACITY_TIMEOUT'
  | 'RETRY_EXHAUSTED'
  | 'DEV_RETRY_BUDGET_EXHAUSTED'
  | 'AUTH_RECOVERY_EXHAUSTED'
  | 'OPERATOR_ABORT';

/**
 * Structured escalation payload emitted by the agent via the ---ESCALATE---
 * or ---NEED-HUMAN--- protocols (Pipeline v1 §8.6). Populated by the
 * universal extractors (Story 1.2). May also be synthesized by the daemon
 * for non-agent-driven triggers (loop detector, preflight, ceilings) so the
 * failed-step panel and inbox have a uniform render shape.
 */
export interface EscalationPayload {
  whatFailed: string;
  whatTried: string[];
  whyStuck: string;
  recommendedAction?: 'retry' | 'salvage' | 'skip' | 'talk' | 'abort';
  humanQuestion?: string;
}

// ── Epic-dev phase discriminator (Arch Doc §3) ──

export type AgentJobPhase = 'epic-dev' | 'epic-review' | 'epic-build';

// ── Pipeline definition (user-configured) ──

export interface AgentConfig {
  name: string;
  allowedTools?: string;
  disallowedTools?: string;
  model?: string; // e.g. 'sonnet', 'opus', 'haiku', 'claude-sonnet-4-6'
}

export type ExtractorType = 'regex' | 'between';

export interface ExtractorConfig {
  type: ExtractorType;
  pattern?: string; // for regex: first capture group is the value
  startDelimiter?: string; // for between: extract text between these
  endDelimiter?: string;
}

export type ValidationType = 'equals' | 'not_contains' | 'contains';

export interface ValidationConfig {
  type: ValidationType;
  left: string; // variable name
  right: string; // variable name or literal (prefixed with "literal:" if not a var)
  label: string;
}

// Step type discriminator
export type PipelineStepType = 'agent' | 'shell';

export interface PipelineStep {
  id: string;
  stepType?: PipelineStepType; // default 'agent' for backward compat
  agentId?: string; // required for agent steps, absent for shell
  prompt?: string; // supports {{VAR_NAME}} template substitution

  // Agent-specific
  resumeFromStep?: string; // step ID whose session to --resume
  extractors?: Record<string, ExtractorConfig>;
  validations?: ValidationConfig[];
  loopTo?: string; // step ID: if validations fail, run that step then re-check this one

  // Shell-specific
  command?: string; // bash command to execute
  timeout?: number; // ms, default 30000
  expectExitCode?: number; // default 0
  captureAs?: string; // store stdout in this variable name
  captureStderrAs?: string; // store stderr in this variable name
  onFail?: {
    action: 'fail' | 'retry_step';
    targetStep?: string;
    injectAs?: string; // variable name to inject error output into
  };
}

export interface PipelineDefinition {
  agents: Record<string, AgentConfig>;
  steps: PipelineStep[];
  maxIterations?: number; // max loop retries (default 1 = no retry)
  initialVariables?: Record<string, string>; // variables injected at pipeline start (e.g., STORY_ID, EPIC_ID)

  // ── Pipeline v2.0 PR-6 (A): retry resume-from-session ──────────────────
  //
  // When a retry job is created from a prior failed/needs-attention job,
  // these fields carry forward the prior runtime state so the daemon's
  // executePipeline can:
  //   1. Skip steps whose `initialStepResults[i].status === 'complete'`
  //      (no need to re-run DEV when the prior attempt's DEV finished
  //      successfully — only the failed step + onwards re-run).
  //   2. For the failed step, set `step.resumeFromStep` so the agent
  //      `--resume <session>`'s the prior step's session — warm context,
  //      cache hits, conversation history all preserved.
  //
  // launchStoryRerun + the job-step retry endpoint populate these. Fresh
  // (non-retry) story dispatches leave them undefined.
  /** Prior job's `stepResults` to seed at pipeline start (skip already-`complete` steps). */
  initialStepResults?: StepResult[];
  /** Prior job's `sessions` map (stepId → claudeSessionId) for `--resume` continuity. */
  initialSessions?: Record<string, string>;
}

// ── Job (stored in DynamoDB) ──

export interface AgentJob {
  jobId: string;
  status: AgentJobStatus;
  createdAt: string;
  updatedAt: string;
  createdBy: string;
  workingDir: string;
  /**
   * Optional for jobs dispatched by `jobType` rather than the legacy per-step
   * pipeline (e.g., Party Epic 15: party-bootstrap/inspect/turn). Legacy jobs
   * set this; epic-dev jobs also provide it for the daemon poll loop's logging.
   */
  pipeline?: PipelineDefinition;

  // Runtime state (written by daemon)
  currentStepIndex?: number;
  variables?: Record<string, string>;
  sessions?: Record<string, string>; // stepId → Claude session ID
  stepResults?: StepResult[];
  totalCost?: number;
  errorMessage?: string;

  // Pipeline Enhancement Plan v2, Phase A.3 — retry ladder state.
  // retryAttempt is 0 for the original run and increments on each re-queue.
  // retryAfter is an ISO timestamp; the poll loop skips PENDING jobs whose
  // retryAfter is in the future.
  retryAttempt?: number;
  retryAfter?: string;

  // ── Pipeline v1 — Failure recovery surface (Epic 1, §9.2) ──
  /**
   * IDs of attention items written for this job. Multiple items can accrete
   * across a job's lifetime (e.g. preflight then escalate then retry-exhaust).
   */
  attentionItemIds?: string[];
  /**
   * Names of extractors that fired before the job hit NEEDS_ATTENTION. If
   * non-empty AND the pipeline step's `salvageable !== false`, the operator
   * may invoke Salvage (Story 1.5) to apply these variables as if the step
   * had succeeded.
   */
  salvageableExtractors?: string[];
  /**
   * Why the job entered NEEDS_ATTENTION (or was Aborted into FAILED). Drives
   * the failed-step panel header copy and inbox filter chips.
   */
  triggeredBy?: JobTriggeredBy;
  /**
   * Structured "agent's last words" payload. Populated either by the agent
   * via the ---ESCALATE--- / ---NEED-HUMAN--- protocols (Story 1.2) or
   * synthesized by the daemon for non-agent-driven triggers.
   */
  escalationPayload?: EscalationPayload;
  /**
   * If this job was created by Story 1.6's Retry action, this points to the
   * original job. The retry chain is followed to enforce the per-step max
   * consecutive retries cap.
   */
  retryOf?: string;

  // Compilation metadata (MY-2 Story Compilation Pipeline)
  compilationStatus?: 'success' | 'failed' | 'skipped';
  compilationStartedAt?: string;
  compilationCompletedAt?: string;

  // Epic-dev discriminator (Arch Doc §3). When `phase` is absent the job uses
  // the legacy per-step pipeline above; when `phase === 'epic-dev'` the daemon
  // routes to `epic-dev-pipeline.mjs` and consumes the fields below.
  phase?: AgentJobPhase;
  epicId?: string;
  projectId?: string;
  epicDevPayload?: EpicDevJobPayload;
  waveResults?: Record<string, WaveResult>;
  resumeFromWaveResults?: Record<string, WaveResult>;
  lastHeartbeatAt?: string;

  // Party module (Epic 15) — alternate execution model dispatched by the
  // daemon's job-router via `jobType`. Each payload is optional and mutually
  // exclusive; exactly one is set per party job.
  jobType?:
    | 'party-bootstrap'
    | 'party-inspect'
    | 'party-turn'
    | 'party-docs-sync'
    | 'party-docs-unlink'
    // Pipeline v2 Phase 1 / Story 1.4.4 — daemon-side App-bootstrap saga
    // (clone → materialize worktree → inject placeholders → npm install →
    // BMAD bootstrap → commit + push). Payload below.
    | 'app-bootstrap';
  partyBootstrapPayload?: {
    projectId: string;
    projectPath: string;
    forceReinstall?: boolean;
    createFolder?: boolean;
  };
  partyInspectPayload?: {
    projectId: string;
    projectPath: string;
  };
  partyTurnPayload?: {
    sessionId: string;
    content: string;
  };
  partyDocsSyncPayload?: {
    projectId: string;
    projectPath: string;
    filename: string;
    s3Bucket: string;
    s3Key: string;
  };
  partyDocsUnlinkPayload?: {
    projectId: string;
    projectPath: string;
    filename: string;
  };
  /**
   * Pipeline v2 Phase 1 / Story 1.4.4 — payload consumed by
   * `daemon/pipelines/app-bootstrap.mjs`. Set when `jobType === 'app-bootstrap'`.
   */
  appBootstrapPayload?: {
    appId: string;
    boilerplateType: 'nextjs' | 'sst' | 'vite' | 'mobile';
    bmadEnabled: boolean;
  };
}

// ── Epic-dev payload types (Arch Doc §3) ──

export type OrchestratorModel = 'opus' | 'sonnet';
export type StoryComplexity = 'trivial' | 'standard' | 'complex' | 'architectural';
export type ReviewRigor = 'light' | 'standard' | 'strict';
export type StoryOutcomeStatus = 'APPROVED' | 'FAILED' | 'BLOCKED' | 'SKIPPED';
export type BlockerCode =
  | 'ambiguous-ac'
  | 'insufficient-touch-points'
  | 'missing-dependency'
  | 'architectural-conflict'
  | 'context-gap'
  | 'environment';

export interface StoryManifestEntry {
  storyId: string;
  title: string;
  wave: number;
  acceptanceCriteria: string[];
  touchPoints: string[];
  complexity: StoryComplexity;
  reviewRigor: ReviewRigor;
  rubricEmphasis?: string[];
  dependsOn?: string[];
}

export interface BlockerRecord {
  code: BlockerCode;
  severity: 'hard' | 'soft';
  description: string;
  affectedPath?: string;
  suggestedResolution?: string;
  detectedAt: number;
}

export interface StoryOutcome {
  status: StoryOutcomeStatus;
  attempts: number;
  reviewAttempts: number;
  filesTouched: string[];
  finalDiff?: string;
  blocker?: BlockerRecord;
  terminalFailure?: string;
}

export interface WaveResult {
  waveNumber: number;
  stories: Record<string, StoryOutcome>;
  durationMs: number;
  completedAt: number;
  persistedAt?: string;
  epicId?: string;
}

export interface EpicDevJobPayload {
  orchestratorModel: OrchestratorModel;
  maxParallel: number;
  maxRemediationRounds: number;
  epicGoal: string;
  contextDigest: string;
  rubric: string;
  stories: StoryManifestEntry[];
}

export interface StepResult {
  stepId: string;
  agentId: string;
  status: 'running' | 'complete' | 'error';
  sessionId?: string;
  cost?: number;
  durationMs?: number;
  model?: string;
  inputTokens?: number;
  outputTokens?: number;
  contextWindow?: number;
  numTurns?: number;
  extractedVariables?: Record<string, string>;
  validationResults?: ValidationResult[];
  errorMessage?: string;
}

export interface ValidationResult {
  label: string;
  passed: boolean;
  details: string;
}

// ── Events (stored in DynamoDB) ──

export type AgentEventType =
  | 'text_delta'
  | 'tool_use'
  | 'tool_result'
  | 'result'
  | 'status'
  | 'step_start'
  | 'step_complete'
  | 'step_error'
  | 'extraction'
  | 'validation'
  | 'compilation-started'
  | 'compilation-completed'
  | 'compilation-failed'
  // Epic-dev orchestrator (Observability Spine §6.1)
  | 'epic_start'
  | 'epic_complete'
  | 'epic_failed'
  | 'wave_start'
  | 'wave_complete'
  | 'wave_split'
  | 'wave_collision'
  | 'subagent_dispatch'
  | 'subagent_return'
  | 'dev_blocker_reported'
  | 'story_blocked'
  | 'blocker_resolved'
  | 'touch_points_expanded'
  | 'context_expanded'
  | 'review_verdict'
  | 'remediation_start'
  | 'story_failed_terminally'
  // Touch-point inference (Epic 3)
  | 'inference_start'
  | 'story_inferred'
  | 'wave_conflict_autosplit'
  | 'inference_failed'
  | 'inference_complete';

export type AgentRole = 'orchestrator' | 'dev' | 'reviewer';

export interface AgentEvent {
  jobId: string;
  eventSeq: string;
  seq: number;
  timestamp: string;
  stepId: string;
  agentId: string;
  eventType: AgentEventType;

  // text_delta / status
  text?: string;

  // tool_use
  toolName?: string;
  toolInput?: string;

  // tool_result
  toolOutput?: string;

  // result / step_complete
  cost?: number;
  sessionId?: string;
  durationMs?: number;

  // extraction
  variableName?: string;
  variableValue?: string;
  extractorType?: string;

  // validation
  validationLabel?: string;
  validationPassed?: boolean;
  validationDetails?: string;

  // compilation events
  compilationEvent?: 'compilation-started' | 'compilation-completed' | 'compilation-failed';
  compilationStatus?: 'success' | 'failed' | 'skipped';
  compilationStartedAt?: string;
  compilationCompletedAt?: string;
  errorMessage?: string;
  errorStack?: string;
  storyId?: string;
  epicId?: string;
  projectId?: string;
  articlesCreated?: number;
  articlesUpdated?: number;
  articlesSuperseded?: number;

  // Epic-dev orchestrator correlation (Observability Spine §6.2)
  waveNumber?: number;
  role?: AgentRole;
  subagentId?: string;
  attempt?: number;
  correlationId?: string;
  payload?: Record<string, unknown>;

  // TTL
  expireAt: number;
}
