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
    | 'ultracode-bench';
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
    counts: Record<string, number>;
    /** FK into futurator-refactor-audits (Epic C durable persistence). */
    auditId?: string;
    /** `<projectPath>/graphify-out/REPORT.md`. */
    reportPath: string;
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
