import type { AuditHotspot, HotspotKind, PrivacyAuditSummary } from './refactor-audit';

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
  | 'COMPLETED_VIA_TALK' // terminal success: operator resolved the job via the Talk-apply flow
  // (from NEEDS_ATTENTION); the applied output advances the wave like the other
  // COMPLETED_VIA_* statuses. See agent-job-state-machine.ts (SUCCESS_STATUSES).
  | 'COMPLETED_VIA_PREWORK' // Pipeline v2.0 T0.2: daemon-side gate verified the AC was already
  // satisfied (recent commits + named exports + tsc clean) BEFORE spawning DEV.
  // Terminal success; no LLM was invoked. Wave/plan reducers treat this like
  // any other COMPLETED_VIA_* status.
  | 'MANUALLY_SKIPPED' // terminal: operator skipped a skipTolerant step
  | 'ORPHANED'; // App/Plan v1 — Plan went terminal before this job dispatched; the
// daemon writes ORPHANED (from PENDING) instead of spawning. Terminal failure-ish
// (not a success — wave/plan reducers do not advance past it as a completion).

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
  /**
   * Pipeline v2 Phase 2-A Story 2-A-1-2 (PR-38) — per-rigor turn cap from
   * the v2.5 §17 matrix. Resolved at spawn time by `role-policy`'s
   * `buildAgentConfig` (TS or MJS). Daemon emits `--max-turns <n>` to the
   * Claude CLI when set; absent / zero / negative → no cap.
   *
   * Today's matrix:
   *   prototype: TEST=6, DEV=8, REVIEWER=4
   *   mvp:       API_AUTHOR=2, TEST=8, DEV=10, REVIEWER=6
   *   production: API_AUTHOR=2, TEST=10, DEV=12, REVIEWER=8, QA=8, PM=6
   *
   * Other roles + rigors → undefined (no cap).
   */
  maxTurns?: number;
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

  // ── Pipeline v1 — Failure recovery gates (Epic 1, §9.2) ──
  /**
   * Story 1.5 — when `false`, the Salvage action is refused for this step even
   * if extractors fired (the extracted output isn't safe to apply without the
   * agent having actually run). Absent / `true` ⇒ Salvage allowed.
   */
  salvageable?: boolean;
  /**
   * Story 1.6 — per-step cap on consecutive Retry jobs (walking the `retryOf`
   * chain). When the chain reaches this length the Retry endpoint refuses.
   * Absent ⇒ the endpoint default (3) applies.
   */
  maxConsecutiveRetries?: number;
  /**
   * Story 1.7 — when `true`, the operator Skip action is allowed for this step
   * (its output is not required by downstream steps). Absent / `false` ⇒ Skip
   * is refused.
   */
  skipTolerant?: boolean;

  /**
   * Pipeline v2 Phase 2-A — PR-51 (2026-05-07).
   *
   * When `true`, the daemon re-resolves PROJECT_CONTEXT before this step
   * executes (so the agent sees the post-state of prior steps' writes).
   * When `false`, the step uses the cached PROJECT_CONTEXT from job start.
   * When absent, the daemon applies the default rule:
   *   - `review`, `retry`, `compile-knowledge` → refresh
   *   - everything else → no refresh
   *
   * Cost: one extra context-pack assembly per refreshed step (~50ms +
   * file reads). Saves agent tool calls (REVIEWER's typical 3-5 Reads
   * after DEV writes go to zero when the pack already reflects the
   * post-state).
   */
  refreshContext?: boolean;

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

// ── Dual-agent comparison ──

/** One lane (agent) of a dual-agent comparison run. */
export interface DualAgentLaneResult {
  /** 'A' = vanilla tools · 'B' = vanilla + Mycelium graph MCP. */
  lane: 'A' | 'B';
  label: string;
  /** Whether this lane had the Mycelium graph MCP tools attached. */
  withGraph: boolean;
  /** The agent's final answer text (empty on error/timeout). */
  answer: string;
  /** Wall-clock latency of the spawn, ms. */
  latencyMs: number;
  /** Token usage as reported by the CLI stream. */
  tokens: { input: number; output: number };
  /** CLI-reported notional cost (total_cost_usd), or null if absent. */
  costUsd: number | null;
  /** Total tool calls the agent made. */
  toolCalls: number;
  /** Of those, how many were Mycelium graph tools (mcp__mycelium__*). 0 for lane A. */
  graphToolCalls: number;
  /** Set when the spawn errored or timed out (answer may be partial/empty). */
  error?: string;
}

// ── Concurrency slot class ──
//
// Pipeline v2 Story 2.6 / 6.3 — a job's scheduling priority for daemon slot
// acquisition. 'background' yields to interactive/critical work (used by
// wave-compile / arch-shard-compile); 'critical' preempts. The pipeline
// builders (wave-compile-pipeline, arch-shard-compile-pipeline) import this
// named union rather than re-declaring it locally.
export type ConcurrencyClass = 'background' | 'interactive' | 'critical';

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
  /**
   * Pipeline v2 Phase 2-A — PR-50 (2026-05-07).
   *
   * Denormalized current step ID — written by the daemon on every step
   * transition alongside `currentStepIndex` (agent-daemon.mjs ~L2193).
   * Used by the UI to render a per-story status badge ('test', 'dev',
   * 'review', 'compile', 'retry', etc.) without re-resolving
   * `pipeline.steps[currentStepIndex].id` on every render.
   *
   * Single DDB write per step transition — no extra events, no scans.
   * Bash-event-driven by design (the daemon's existing `step_start`
   * push is the trigger; the field update is part of that same code
   * path).
   */
  currentStepId?: string;
  variables?: Record<string, string>;
  sessions?: Record<string, string>; // stepId → Claude session ID
  stepResults?: StepResult[];
  totalCost?: number;
  errorMessage?: string;

  /**
   * Pipeline v2 Story 2.6 / 6.3 — the job's daemon slot-acquisition priority.
   * Mutated by `POST /api/jobs/:jobId/promote-class`. Absent on legacy jobs
   * (the daemon defaults them to 'interactive'). Compile jobs (wave-compile,
   * arch-shard-compile) run as 'background' so they yield to active dev/review.
   */
  concurrencyClass?: ConcurrencyClass;
  /**
   * Pipeline v1 Story 4.3 — per-job cost cap in USD. Raised by
   * `POST /api/jobs/:jobId/raise-cost-ceiling`; the daemon's cost meter halts
   * the job into NEEDS_ATTENTION (triggeredBy 'COST_CEILING') when exceeded.
   * Absent ⇒ no per-job cap (the plan-level ceiling still applies).
   */
  costCeilingUsd?: number;

  /**
   * QA send-back remediation marker (2026-06-03). Set by the send-back
   * endpoint on a single-story rerun job. When the rerun reaches terminal
   * SUCCESS, the daemon enqueues a one-shot `wave-merge` job for THIS story so
   * the fix on `wip/<storyId>` (forked from the current `plan/<slug>` tip, so a
   * clean fast-forward) is integrated into `plan/<slug>` — which is what QA
   * reads. Without this, a single-story fix never re-reaches the plan branch
   * (the forward-only wave-reducer won't re-fire a completed wave's merge).
   */
  remediationMerge?: {
    appId: string;
    planId: string;
    planSlug: string;
    epicId: string;
    waveNumber: number;
    storyId: string;
  };

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
  /**
   * QA-Review W1 — set on P3 (epic-less) DEPLOY jobs so `postDeployWriteback`
   * resolves the plan directly instead of hopping through an epic. Absent on
   * legacy jobs, which carry `epicId` instead.
   */
  planId?: string;
  /** QA-Review W2 — set on a `p3-qa` job: the deployed URL QA drives. */
  devUrl?: string;
  /** QA-Review W2 — set on a `p3-qa` job: the frozen commit QA pins to. */
  qaCommitSha?: string;
  /**
   * QA-Review — the boilerplate's seam hook (registry testHarness.seamHook),
   * resolved at enqueue so the daemon's static seam-mount check knows what to
   * grep for. Boilerplate metadata, never a pipeline constant.
   */
  seamHook?: string;
  /**
   * Deployment v2.5 — which environment a DEPLOY job publishes to. Set by the
   * deploy endpoint + the cron auto-trigger. The daemon's `postDeployWriteback`
   * advances `main` ONLY when this is `production`; `dev`/`staging` deploys
   * record a preview URL and never touch the trunk. Absent on legacy deploy
   * jobs (treated as `production` for back-compat).
   */
  deployEnvironment?: 'dev' | 'staging' | 'production';
  /**
   * Deployment v2.5 — set on ROLLBACK jobs. A rollback restores prior
   * production hosting from an archived release; it must NOT fast-forward
   * `main` (the trunk already has that release or later). The daemon gates the
   * merge-to-main on `deployEnvironment === 'production' && !skipTrunkAdvance`.
   */
  skipTrunkAdvance?: boolean;
  projectId?: string;
  epicDevPayload?: EpicDevJobPayload;
  waveResults?: Record<string, WaveResult>;
  resumeFromWaveResults?: Record<string, WaveResult>;
  lastHeartbeatAt?: string;
  /** Operator-requested abort: the daemon's poller SIGKILLs the job's children and
   *  flips the job terminal. Set by the abort/cancel endpoints. */
  abortRequested?: boolean;

  // Reality-Spine P3 Integrator (jobType==='integrator'). The row is otherwise
  // schemaless at rest and the daemon routes/reads these off the .mjs job-router;
  // typed here so the TS enqueue path (wave-completion-check.ts) is honest.
  /** App/plan slug the integrator operates on. */
  appId?: string;
  planSlug?: string;
  /** Human-readable blocking-verdict summary handed to the integrator prompt. */
  failureSummary?: string;
  /** Head SHA the integrator targets — pins the at-most-once-per-head enqueue guard. */
  targetHeadSha?: string;

  // Party module (Epic 15) — alternate execution model dispatched by the
  // daemon's job-router via `jobType`. Each payload is optional and mutually
  // exclusive; exactly one is set per party job.
  jobType?:
    | 'party-bootstrap'
    | 'party-inspect'
    | 'party-turn'
    | 'party-docs-sync'
    | 'party-docs-unlink'
    // Story 15.4 — brownfield refresh.
    | 'party-refresh'
    // Pipeline v2 Phase 1 / Story 1.4.4 — daemon-side App-bootstrap saga
    // (clone → materialize worktree → inject placeholders → npm install →
    // BMAD bootstrap → commit + push). Payload below.
    | 'app-bootstrap'
    // Labs3 fast path (2026-07-01) — intent → plan_spec. Waits for the app
    // scaffold, then one Claude call generates StoryNodes the ready-frontier
    // runs (no epics/waves). Payload: quickPlanspecPayload below.
    | 'quick-planspec'
    // Epic 18 / Story 18.5 — Free Claude Code Agent session turn. Payload below.
    | 'free-agent-session'
    // Pipeline v2 Phase 3-C Epic 3 (2026-05-20) — SKILL-SCOUT agent runs.
    // T1: post-bootstrap (full federation sweep). T2: pre-PM (intent-
    // targeted resolve). T3-T8: deferred wire-ins. Payload below.
    | 'skill-scout'
    // Epic 3 Story 3.6 — operator-confirmed (or auto-confirmed) skill
    // install: apply manifest deltas + re-run vendor-skills + commit.
    | 'skill-install'
    // Epic 6 wire-in (2026-05-20) — REFLECTOR runs at plan close. The
    // plan-reducer enqueues these; daemon's executeReflectorJob picks
    // them up (Epic 6 follow-on — daemon dispatch wire is held back
    // alongside the Slice C work).
    | 'reflector'
    // Plan Retrospect / The Assessor (plan-retrospect-spec §4b). The API
    // enqueues these after storing the deterministic slice; the daemon's
    // executeScorecardAssessJob grades the stage's [LLM] criteria.
    | 'scorecard-assess'
    // Refactoring Assessment Module (Epic B). Deterministic recon (~0 LLM)
    // over a migrated brownfield clone + optional L3 adjudication (Epic C).
    // Daemon's executeRefactorAuditJob runs recon.mjs as a plain Node child.
    | 'refactor-audit'
    // Ultracode-Reverse bench. The daemon's executeUltracodeBenchJob captures a
    // real `ultracode` planner run (halt-on-script-write, before fan-out), runs
    // the Case-2 projector, scores both with the spikes/ultra-reverse engine, and
    // writes the scorecard to the ultracode-runs table. Payload below.
    | 'ultracode-bench'
    // Dual-agent comparison harness. The daemon's executeDualAgentCompareJob spawns
    // TWO `claude` agents on the SAME question over an assessed app's clone — Agent A
    // with vanilla tools, Agent B additionally equipped with the Mycelium graph MCP —
    // and captures each one's answer, latency, tokens, cost, and graph-tool usage so
    // the operator can judge whether the graph yields better answers. Payload below.
    | 'dual-agent-compare'
    // Refactoring Scan Engine v2. Hybrid deterministic recon + LLM swarm →
    // dimension-tagged findings + a phased dependency-ordered plan. Payload below.
    | 'scan-engine'
    // QA-Review W2 — deployed-app QA of a P3 plan (journeys + VQA against
    // plan.devUrl, pinned to plan.qaCommitSha). Carries planId/devUrl/qaCommitSha.
    | 'p3-qa'
    // Reality-Spine P3 (2026-07-08) — the Integrator role: ONE Opus agent with
    // whole-tree write authority that loops to full green (tsc && lint && test &&
    // build && boot) then commits, before the plan may enter review. Also the
    // first responder to a blocking QA verdict. See daemon/pipelines/integrator-pipeline.mjs.
    | 'integrator'
    // Queues module — one inbound external REST call (atlassinator/applicator/
    // gomad/mycelium/…). The API writes a queue-requests row + enqueues this job;
    // the daemon's executeQueueRequestJob spawns `claude -p` and streams the live
    // terminal into agent-events. Payload below (queueRequestPayload).
    | 'queue-request'
    // B1 — File Explorer control-job primitive. The API enqueues one pinned to
    // `assignedServerId` (B3); `daemon/pipelines/file-browse.mjs` (B2) lists/reads
    // under its own FUTURATOR_BROWSE_ROOT and writes back `fileBrowseResult`.
    // Payload: `fileBrowsePayload` (both below).
    | 'file-browse';
  partyBootstrapPayload?: {
    projectId: string;
    projectPath: string;
    forceReinstall?: boolean;
    createFolder?: boolean;
    /** Story 15.4 — discriminator. 'greenfield' (default) or 'brownfield'. */
    kind?: 'greenfield' | 'brownfield';
    /** Story 15.4 — brownfield only. */
    gitRepoUrl?: string;
    /** Story 15.4 — brownfield only. */
    gitBranch?: string;
  };
  /** Story 15.4 — brownfield refresh payload. */
  partyRefreshPayload?: {
    projectId: string;
    projectPath: string;
    gitBranch: string;
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
  /**
   * Labs3 fast path (2026-07-01) — the quick-planspec generation job. The
   * daemon waits for `appBootstrapJobId` to scaffold the fresh app, then turns
   * `intent` into StoryNodes for `planId`/`appId`.
   */
  quickPlanspecPayload?: {
    planId: string;
    appId: string;
    intent: string;
    appBootstrapJobId?: string;
    /**
     * The boilerplate's seam hook (BOILERPLATE_REGISTRY[type].testHarness
     * .seamHook) — stamped by the quick-create endpoint so the planner prompt
     * names the REAL hook instead of hardcoding an app-kind (game/dashboard).
     */
    seamHook?: string;
  };
  appBootstrapPayload?: {
    appId: string;
    // PR-13 — keep this loose (`string`) so adding new starter packs in
    // the registry doesn't require a coordinated daemon rebuild. Daemon
    // validates against the registry at runtime.
    boilerplateType: string;
    bmadEnabled: boolean;
    /**
     * PR-13 — starter pack augment files. The API Lambda reads
     * `BOILERPLATE_REGISTRY[boilerplateType].augmentFiles` and embeds
     * them here so the daemon doesn't need its own copy of the registry.
     * Written to the working tree between inject-values and npm-install.
     */
    augmentFiles?: Array<{ path: string; content: string }>;
    /**
     * dino1 root-cause (2026-06-10) — npm scripts the daemon merges into the
     * scaffolded package.json (missing keys only). Carries the registry's
     * `packageJsonScripts` (e.g. predev/prebuild → wiring generator).
     */
    packageJsonScripts?: Record<string, string> | null;
    /**
     * pacman1 disease (2026-06-11) — devDependencies the daemon merges into
     * the scaffolded package.json before npm-install (missing keys only).
     * Carries the registry's `packageJsonDevDependencies` (the test runner
     * pin) so test infra is template-owned and story-immutable.
     */
    packageJsonDevDependencies?: Record<string, string> | null;
    /**
     * Epic 2 Story 2.2 (2026-05-19) — starter's default skill loadout.
     * Each entry is a `<skill>@<source>` token. The daemon's
     * `prepin-default-skills` step pins these into
     * `.claude/skills.manifest.yaml` under `core[]` so the subsequent
     * `vendor-skills` step (Story 2.3) can fetch each SKILL.md body.
     *
     * `null` for stub boilerplates (sst/vite/mobile); `undefined` for
     * legacy app rows created before this field was threaded. Daemon
     * treats both identically — prepin skips with `no-default-loadout`.
     */
    defaultSkillLoadout?: string[] | null;
  };

  /**
   * Pipeline v2 Phase 3-C Epic 3 / Story 3.1 (2026-05-20) — payload
   * consumed by `daemon/pipelines/skill-scout-job-runner.mjs`. Set when
   * `jobType === 'skill-scout'`.
   *
   * Each SKILL-SCOUT job runs a single agent step against the project's
   * current `.claude/skills.manifest.yaml` + the federation manifest at
   * `~/.futurator/skill-federation.yaml`, then either auto-confirms
   * (prototype + high-confidence T1/T2/T5/T7) via `applyConfirmedProposals`
   * or surfaces a decision card (mvp+ rigor, low confidence, or T3/T4/
   * T6/T8 which never auto-confirm).
   */
  skillScoutPayload?: {
    /** Which trigger fired. v2.5 §38 enumerates eight; v1 wires T1+T2. */
    trigger: 'T1' | 'T2' | 'T3' | 'T4' | 'T5' | 'T6' | 'T7' | 'T8';
    /** App slug = working-dir basename. */
    projectSlug: string;
    /** App row's `appId` — duplicates projectSlug today; kept distinct so
     *  the multi-app monorepo future doesn't need a schema change. */
    appId: string;
    /** Set for T2 (plan-intent) + T4 (PM speculation) + T7 (stream
     *  graduation). Null for T1/T3/T5/T6/T8 (app-level triggers). */
    planId?: string | null;
    /** Plan intent text — only present for T2. Used by the prompt to
     *  ground proposals in the user's stated goal. */
    planIntent?: string;
    /** Drives the rigor matrix in disposeProposals. T1 hardcodes
     *  'prototype' (no plan exists yet); T2+ inherit the plan's rigor. */
    rigor: 'prototype' | 'mvp' | 'production';
  };

  /**
   * Epic 6 wire-in (2026-05-20) — REFLECTOR job payload. Set when
   * `jobType === 'reflector'`. The plan-reducer enqueues these at
   * plan close (status flip to 'review'); the daemon's
   * executeReflectorJob (follow-on) reads this shape.
   *
   * Mirror of `buildReflectorJobPayload` in
   * `daemon/lib/reflector-scheduler.mjs`. Schema-wise the two stay in
   * lock-step.
   */
  reflectorPayload?: {
    scope: 'plan' | 'wave' | 'story';
    planId: string;
    planSlug?: string;
    projectSlug?: string;
    rigor: 'prototype' | 'mvp' | 'production';
    epicId?: string | null;
    waveNumber?: number | null;
  };

  /**
   * Plan Retrospect / The Assessor (plan-retrospect-spec §4b). Set when
   * `jobType === 'scorecard-assess'`. The API computes + stores the
   * deterministic slice first, then enqueues this; the daemon's
   * `executeScorecardAssessJob` reads the stored slice, grades the stage's
   * `[LLM]` criteria, and writes the Assessor slices back to
   * `futurator-scorecards`.
   */
  scorecardAssessPayload?: {
    planId: string;
    stage: 'concept' | 'development' | 'qa' | 'deployment' | 'publish' | 'overview';
    rubricVersion: string;
    pipelineVersion?: string;
  };

  /**
   * Refactoring Assessment Module (Epic B). Set when `jobType === 'refactor-audit'`.
   * The API enqueues this after the operator clicks "Assess" on a migrated
   * brownfield project; the daemon's `executeRefactorAuditJob` runs `recon.mjs`
   * as a plain Node child (deterministic, ~0 LLM tokens), then — when `runL3`
   * is set — the optional Epic C `/assess-codebase` adjudication. `projectPath`
   * is the EC2 clone (== `workingDir`) and the `<repo>` arg to recon.
   *
   * The full superset (incl. `runL3`/`topN`) is declared here even though
   * Epic B ignores the L3 gates — keeping the type stable for Epic C.
   */
  refactorAuditPayload?: {
    projectId: string;
    projectPath: string;
    /** Source subdir passed to recon (`--src`). Default 'src'. */
    src?: string;
    /** Resume: reuse an existing fresh `graph.json` (`--skip-graphify`). */
    skipGraphify?: boolean;
    /** Epic C gate — run `/assess-codebase` adjudication after recon. */
    runL3?: boolean;
    /** Hotspots passed to L3 (default 40, matches `hotspot-detect --top`). */
    topN?: number;
    /** Data Privacy Assessment lane — run privacy-recon in PARALLEL with recon. */
    runPrivacy?: boolean;
    /** 'internal' (our own scanner, default) | 'external' (GDPR service). */
    privacyMode?: 'internal' | 'external';
  };

  /**
   * Dual-agent comparison harness. Set when `jobType === 'dual-agent-compare'`.
   * The daemon spawns TWO `claude` agents on the SAME `question` in the assessed
   * app's clone (`projectPath`): Agent A with vanilla tools, Agent B additionally
   * given the Mycelium graph MCP tools. The isolated variable is graph access.
   */
  dualAgentComparePayload?: {
    projectId: string;
    projectPath: string;
    /** The natural-language question both agents answer about the codebase. */
    question: string;
    /** Both agents run at the SAME model (the isolated variable is graph access). */
    model?: string; // default 'opus'
    /** Per-agent wall-clock cap before the spawn is killed (default 240000). */
    timeoutMs?: number;
  };

  /**
   * Refactoring Scan Engine v2 input. Set when `jobType === 'scan-engine'`. The
   * daemon's executeScanEngineJob runs recon + subsystem-decompose + the LLM
   * swarm over the brownfield clone and writes a phased plan.
   */
  scanEnginePayload?: {
    projectId: string;
    projectPath: string;
    /** Source subdir for recon (`--src`). Default 'src'. */
    src?: string;
    /** Max subsystems given a dedicated analyzer (cap/sample). Default 24. */
    cap?: number;
    /** Privacy lane: 'internal' (our scanner, default) | 'external' (GDPR service). */
    privacyMode?: 'internal' | 'external';
    /** 'full' (default, recon + LLM swarm) | 'deterministic' (no swarm; ~0 LLM). */
    mode?: 'full' | 'deterministic';
    /** Granular re-scan: re-run only these swarm tasks (subsystem shardKeys and/or
     *  cross-cutting pass areas) and merge into the persisted scan. */
    targets?: string[];
    /** Reuse cached recon (skip graphify/decompose/deps). Default true when targeted. */
    reuseRecon?: boolean;
    /** Auto-target the subsystems whose files changed since the last-scanned SHA. */
    autoTargetChanged?: boolean;
  };

  /** Denormalized headline of a `scan-engine` run; the full scan rides S3. */
  scanEngineSummary?: {
    auditId: string;
    findingCount: number;
    counts: {
      total: number;
      deterministic: number;
      llm: number;
      byDimension: Record<string, number>;
    };
    phaseCount: number;
    gateViolations: number;
    lowConfidence: boolean;
    /** Whether scan.json was uploaded to S3 (knowledge-live/<id>/_refactor/scan.json). */
    scanAvailable: boolean;
    reportPath: string | null;
  };

  /** Result of a `dual-agent-compare` run — denormalized onto the job row (MVP transport). */
  dualAgentCompareResult?: {
    question: string;
    model: string;
    agentA: DualAgentLaneResult; // vanilla tools
    agentB: DualAgentLaneResult; // + Mycelium graph MCP
  };

  /**
   * Ultracode-Reverse bench. Set when `jobType === 'ultracode-bench'`. `jobId === runId`.
   *
   * SYMMETRIC FRAME (2026-06-24): both engines run a SINGLE `claude` invocation at the SAME
   * model + effort, on the daemon, differing ONLY in the prompt — Case 1 = native `ultracode`
   * (captured via kill-on-script-write halt), Case 2 = our Futurator Workflow Author meta-prompt
   * (`claude -p`, output-only, no execution). The daemon AST-parses BOTH scripts into the
   * DecisionPlan IR and scores them. Guardrails are a later layer, not part of this frame.
   */
  ultracodeBenchPayload?: {
    runId: string;
    operatorId: string;
    intent: string;
    target: 'greenfield' | 'brownfield';
    rigor: 'prototype' | 'mvp' | 'production';
    reps: number;
    /** Both engines run at the SAME model + effort (the isolated variable is the prompt). */
    model?: string; // default 'opus' (Opus 4.8)
    effort?: string; // default 'xhigh'
    /** Version of the Futurator Workflow Author meta-prompt used for Case 2. */
    metaPromptVersion?: string;
    judge?: boolean;
    captureTimeoutMs?: number;
    claudeVersion?: string;
  };

  /**
   * Small denormalized summary written back onto the job row by
   * `executeRefactorAuditJob` (like `reflectorProposalCount`), so the UI can
   * render headline counts from the job without re-reading `hotspots.json`.
   */
  refactorAuditSummary?: {
    hotspotCount: number;
    counts: Partial<Record<HotspotKind, number>>;
    /**
     * The full ranked hotspot list (MVP transport). The recon writes
     * `hotspots.json` to the EC2 clone disk, which the API Lambda can't read —
     * so the daemon denormalizes the array onto this no-TTL job row and the
     * dashboard reads it via `GET /agent-jobs/:id`. ~27KB on applicator, well
     * under the 400KB DDB item limit. Epic C may later move the source to the
     * durable `futurator-refactor-audits` table.
     */
    hotspots?: AuditHotspot[];
    /** FK into futurator-refactor-audits (Epic C durable persistence). */
    auditId?: string;
    /** `<projectPath>/graphify-out/REPORT.md`. */
    reportPath: string | null;
    /** Whether the file-level graph projection was uploaded to S3 (Graph tab). */
    graphAvailable?: boolean;
    /** Total hotspots detected vs shown (surfaces any cap — no silent truncation). */
    detectedCount?: number;
    shownCount?: number;
    /** Recon tool availability (e.g. { graphify:'ok', knip:'unavailable' }). */
    toolStatus?: Record<string, string>;
    /** Data Privacy Assessment summary (when runPrivacy was set). */
    privacy?: PrivacyAuditSummary;
  };

  /**
   * Epic 3 Story 3.6 (2026-05-20) — payload consumed by
   * `daemon/pipelines/skill-install-job-runner.mjs`. Set when
   * `jobType === 'skill-install'`.
   *
   * Carries the proposals subset the operator confirmed (or
   * auto-confirm in the T1/T2 prototype path). The daemon writes the
   * manifest, re-runs vendor-skills, and commits with `Agent:
   * SKILL-SCOUT` trailer.
   */
  skillInstallPayload?: {
    projectSlug: string;
    appId: string;
    /** SkillScoutOutput shape minus the trigger context — proposals
     *  are filtered by the operator's accept set if edit was used. */
    output: {
      trigger: 'T1' | 'T2' | 'T3' | 'T4' | 'T5' | 'T6' | 'T7' | 'T8';
      projectSlug: string;
      proposals: Array<{
        kind: 'add' | 'remove' | 'upgrade';
        source: string;
        skill: string;
        manifestBucket: 'core' | 'stack' | 'domain' | 'vendor';
        version: string;
        rationale: string;
        verifyNotes: string;
        confidence: number;
      }>;
    };
    /** Whether the install came from auto-confirm or operator-confirm.
     *  Affects the commit message attribution and the forensic event
     *  payload but NOT the on-disk side effect. */
    source: 'auto-confirm' | 'operator-confirm';
    /** Attention-item ID the operator action originated from. Logged in
     *  the forensic event so the decision-card → install lineage is
     *  reconstructable. Absent for auto-confirm. */
    originAttentionId?: string;
  };

  /**
   * Epic 18 / Story 18.5 — payload consumed by
   * `daemon/pipelines/free-agent-session.mjs`. Set when
   * `jobType === 'free-agent-session'`.
   *
   * Credentials are minted by the API Lambda via STS AssumeRole (Story 18.1)
   * and threaded through this payload to the daemon, then injected into the
   * spawned `claude -p` subprocess via env vars. Never logged or persisted.
   */
  freeAgentSessionPayload?: {
    sessionId: string;
    projectId: string;
    scope: {
      kind: 'project' | 'plan' | 'app' | 'workspace';
      id?: string;
    };
    model: string;
    costCapUsd: number;
    credentials: {
      accessKeyId: string;
      secretAccessKey: string;
      sessionToken: string;
      expiration: string;
    };
    messages: Array<{ role: 'user' | 'assistant' | 'system'; content: string }>;
  };

  /**
   * Queues module — payload consumed by `daemon/pipelines/queue-request.mjs`.
   * Set when `jobType === 'queue-request'`. Carries everything the runner needs
   * to spawn `claude -p` and (optionally) deliver the answer, without a second
   * DDB read of the queue-requests row.
   */
  queueRequestPayload?: {
    requestId: string;
    prompt: string;
    source?: string;
    target?: 'ec2' | 'local';
    workingDir?: string;
    model?: string;
    autoRespond?: boolean;
    callbackUrl?: string;
  };

  /**
   * B1 — File Explorer control-job primitive. Set when `jobType ===
   * 'file-browse'`. Consumed by `daemon/pipelines/file-browse.mjs` (B2), which
   * lists/reads under a server-scoped root (`FUTURATOR_BROWSE_ROOT`) with
   * traversal rejection. `GET /api/ec2/files` (op 'list') and `GET
   * /api/ec2/files/content` (op 'read') enqueue this instead of calling SSM
   * directly (B4).
   */
  fileBrowsePayload?: {
    op: 'list' | 'read';
    path: string;
    serverId: string;
  };

  /**
   * Result of a `file-browse` job, denormalized onto the job row so the API
   * Lambda can relay it in the existing wire shapes without a second read
   * (B4). `entries` populates the 'list' op — mirrors `FileEntry`
   * (`src/hooks/use-ec2-files.ts:5-11`). The remaining fields populate the
   * 'read' op — mirrors `FileContentResponse` (`use-ec2-files.ts:31-43`).
   */
  fileBrowseResult?: {
    op: 'list' | 'read';
    path: string;
    /** 'list' op only. */
    entries?: Array<{
      name: string;
      type: 'file' | 'directory';
      size: number;
      permissions: string;
      modified: string;
    }>;
    /** 'read' op only. */
    kind?: 'text' | 'image' | 'pdf' | 'binary';
    mime?: string;
    size?: number;
    mtime?: number;
    content?: string;
    base64?: string;
    tooLarge?: boolean;
    maxBytes?: number;
  };

  // ── Pipeline-3 (development-plan §7) — additive, all optional ──────────────
  // The resolved P3 flag-set, frozen onto the job at claim by
  // `daemon/lib/pipeline-flags.mjs#freezeFlagsOntoJob`. Once present, a job's
  // P3 behavior is fixed for its lifetime even if operator env changes. Absent
  // on legacy jobs ⇒ every capability reads its OFF default.
  p3Flags?: Partial<{
    P3_GATE_MODE: 'off' | 'audit' | 'enforce';
    P3_LAZY_MODE: 'off' | 'lite' | 'full' | 'ultra';
    P3_COST_CEILING: 'off' | 'observe' | 'enforce';
    P3_READY_FRONTIER: 'off' | 'shadow' | 'on';
    P3_BOUND_AC_GATE: 'off' | 'shadow' | 'on';
    P3_WORKTREE_CACHE: 'off' | 'on';
    P3_SESSION_REUSE: 'off' | 'dev_compile' | 'full';
    P3_COMPACTION: 'off' | 'on';
  }>;
  /**
   * StoryNode linkage (Phase 2B). When a job is minted from a `plan-spec-graph`
   * StoryNode rather than a legacy wave story, this points back at the node that
   * is the unit of schedule/spec/completion (the job stays the unit of
   * execution). Absent on legacy jobs.
   */
  storyNodeRef?: { storyId: string; planId: string };
  /** Resolved dev-job scope contract (Phase 2A) — touches/forbidden/binding env. */
  devContractRef?: { allowedPaths: string[]; forbiddenAreas: string[] };
  /** Atomic-claim lease state (Phase 2A). */
  claimOwner?: string;
  claimToken?: string;
  claimExpiresAt?: string;
  /** StoryNode lifecycle mirror (Phase 2A): blocked|ready|claimed|developing|merging|verifying|done|failed. */
  storyState?: string;
  dependsOn?: string[];
  /** Worktree isolation (Phase 3A). */
  worktreePath?: string;
  worktreeBranch?: string;
  depCacheMode?: 'shared' | 'symlink-ro' | 'independent';

  // ── Servers module — server-aware dispatch (spec §5) ──────────────────────
  /**
   * Dispatch affinity key. Stamped `plan:<planId>` on every plan-scoped job at
   * creation so `dispatch-policy.ts#planAssignments` pins all of a plan's jobs
   * to one server (the plan's worktree/branch lives on that box). Absent on
   * non-plan jobs (queue-request, free-agent-session, app-level skill-scout).
   */
  affinityKey?: string;
  /**
   * The server this job is assigned to. Normally stamped by the sweeper
   * (`server-dispatcher.ts`) or the inline daemon self-assign optimization at
   * creation. The fleet daemon polls the `assignedServerId-status-index`
   * partition for its own SERVER_ID. Absent ⇒ awaiting sweeper assignment.
   */
  assignedServerId?: string;
  /** ISO timestamp the assignment was stamped. */
  assignedAt?: string;
  /** Human-readable why (e.g. `affinity plan:<id> -> <server>`, or
   *  `inherited: plan affinity (parent <jobId>)` for the daemon self-assign). */
  assignReason?: string;
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
  | 'skill_loaded'
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
  | 'inference_complete'
  // pacman1 timer fix (2026-06-12) — skills-substrate bookkeeping events the
  // daemon has emitted since the Epic 2/3 skill rollout but that were never
  // declared here, so every one fell into the classifier's 'unattributed'
  // honesty bucket (6.8% of the pacman1 forensic). They mark prompt-assembly
  // work (skill manifests resolved, a skill activated, CLAUDE.md loaded).
  | 'skills_available'
  | 'skill_activated'
  | 'claude_md_loaded';

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

  // skill_loaded — skills PUSH-injected into a story-dev agent
  skills?: string[];

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
