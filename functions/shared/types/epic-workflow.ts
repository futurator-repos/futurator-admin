export type EpicStatus =
  | 'draft'
  | 'ready'
  | 'in_progress'
  | 'in_review'
  | 'fixing'
  | 'completed'
  | 'failed'
  | 'deployed';
export type StoryStatus =
  | 'pending' // never launched (no jobId yet)
  | 'queued' // job created as PENDING; waiting for daemon slot
  | 'running' // daemon actively executing
  | 'in_review'
  | 'fixing'
  | 'done'
  | 'failed'
  | 'skipped'
  | 'blocked';
export type CompilationStatus = 'success' | 'failed' | 'skipped';

// ── Blocker taxonomy (Epic 5; Arch Doc §7) ──

export type BlockerCode =
  | 'ambiguous-ac'
  | 'insufficient-touch-points'
  | 'missing-dependency'
  | 'architectural-conflict'
  | 'context-gap'
  | 'environment';

export type BlockerSeverity = 'hard' | 'soft';

export type BlockerResolutionAction = 'amend' | 'skip' | 'retry';

export interface BlockerRecord {
  code: BlockerCode;
  severity: BlockerSeverity;
  description: string;
  affectedPath?: string;
  suggestedResolution: string;
  requestedTouchPointExpansion?: string[];
  attemptsBeforeBlock: number;
  reportedAt: string;
  reportedByAttempt: number;
  waveNumber: number;
  subagentId?: string;
}

export interface BlockerResolutionRecord {
  resolvedAt: string;
  resolvedBy: string;
  action: BlockerResolutionAction;
  reason: string;
  amendedFields?: Array<keyof EpicStory>;
}

// ── Touch-point inference (Epic 3) ──

export type StoryComplexity = 'trivial' | 'standard' | 'complex' | 'architectural';
export type ReviewRigor = 'light' | 'standard' | 'strict';
export type InferenceConfidence = 'low' | 'medium' | 'high';

export interface InferenceMetadata {
  inferredAt: string;
  model: 'haiku';
  confidence: InferenceConfidence;
  reasoning?: string;
  retries?: number;
}

export interface CompilationArticleCounts {
  created: number;
  updated: number;
  superseded: number;
}

// ── Acceptance criteria & visual test definitions ──

/**
 * Concept v2 — the PM-set *verify intent* (planning altitude). It is the source
 * the downstream QA-AUTHOR derives the concrete VQA L-level from at story-dev
 * start; the PM never sets L0/L1/L2 directly (a mechanism fact unknown until the
 * test seam exists). See `docs/concepts/pipeline-v3/concept-stage-v2-bmad.md` §4.
 *   build      → typecheck/unit (no browser)
 *   appearance → idle-visible vision check (L1)
 *   state      → deterministic seam read (L2-state if a seam exists, else L1)
 *   behavior   → reach→act→observe probe (L2)
 *   manual     → human-in-the-loop operator lane (blocks ship); needs manualReason
 */
export type VerifyIntent = 'build' | 'appearance' | 'state' | 'behavior' | 'manual';

/**
 * Concept v2 / VQA v3 — closed reason enum for `verify: 'manual'` ACs (§8 gate,
 * VQA §11 H12). Seven named classes each map to a known "stub possible?" verdict
 * against the boilerplate contract; `no-stub-possible` is the QA-AUTHOR routing
 * catch-all. Required iff `verify === 'manual'`. Reserved for the *knowably*
 * unautomatable so `manual` cannot become the new UNVERIFIABLE escape hatch.
 */
export type ManualReason =
  | 'real-payment'
  | 'oauth-consent'
  | 'captcha'
  | 'native-device'
  | 'email-sms-loop'
  | 'subjective-quality'
  | 'video-audio-perception'
  | 'no-stub-possible';

export interface AcceptanceCriterion {
  id: string; // e.g., "AC-1"
  text: string; // plain English description (remains the legacy / fallback form)
  needsBrowser: boolean; // does verification require a running browser?

  // ── Concept v2 (BMAD BDD structure) — all optional; legacy flat-`text` ACs
  //    and `prototype` runs are unaffected. ──
  given?: string; // precondition / initial state
  when?: string; // action or trigger
  then?: string; // expected outcome — PROSE-OBSERVABLE (a human claim), never a raw seam expr
  thenObservable?: string; // optional hint for the QA-AUTHOR's prose→assert compilation

  /** PM-set verify intent (sibling of `needsBrowser`). Source for the QA-AUTHOR's L-level. */
  verify?: VerifyIntent;
  /** Required iff `verify === 'manual'`; validated against the closed enum at the gate. */
  manualReason?: ManualReason;
}

/**
 * Pipeline v2.0 PR-8 (Q2.2/Q3.1) — three-level test routing.
 *
 * Each test runs at exactly one level (no mid-flight escalation):
 *   • L0 — pure bash. URL returns 200, console clean, screenshot non-blank,
 *          page contains expected text. No LLM. ~$0/~1s per test.
 *   • L1 — Haiku judge of a single screenshot vs a specific visual expect.
 *          ~$0.005/~5s per test.
 *   • L2 — Sonnet judge of a multi-step Playwright flow's screenshots.
 *          ~$0.05/~30-60s per test.
 *
 * Levels are auto-classified by `classifyVisualTest` at qa-aggregate time
 * and overridable at the operator-gated test contract review.
 */
export type VisualTestLevel = 'L0' | 'L1' | 'L2';

/**
 * Comparison operator for the L2-state `assert` oracle (VQA v3 FR-4). The
 * assert step reads `window.__harness.snapshot()`/`events` and compares with one
 * of these — a deterministic verdict, no LLM call.
 */
export type AssertOp = 'eq' | 'neq' | 'gt' | 'gte' | 'lt' | 'lte' | 'contains' | 'truthy' | 'falsy';

/**
 * The probe action grammar (VQA v3 E2.1). Driver-agnostic on purpose — these are
 * intent verbs, not Playwright calls, so a future native driver can interpret the
 * same grammar (FR-29). The first five are the legacy set (back-compat).
 */
export type ProbeStepAction =
  // ── legacy (pre-v3) ──
  | 'navigate'
  | 'click'
  | 'wait'
  | 'screenshot'
  | 'fill'
  // ── VQA v3 interaction grammar (FR-2) ──
  | 'press'
  | 'hold'
  | 'tap'
  | 'pointer'
  | 'clock'
  | 'select'
  | 'drag'
  | 'assert'
  | 'seed'
  // ── VQA v3 Phase 2 — agentic event-driven verbs ──
  /** Block until a `window.__harness` condition holds (poll-until-event). */
  | 'waitForEvent'
  /** Repeat an inner action until a `window.__harness` condition holds or budget
   *  elapses (e.g. press a key until status===over). The genuine reach-to-event. */
  | 'repeat'
  /** TEST-ONLY: jump the game to a terminal state via window.__harness.forceStatus
   *  (Phase 2b) — reach gameover/win deterministically without playing to it. */
  | 'force'
  // ── H10 coverage-class grammar gaps ──
  | 'viewport'
  | 'upload'
  | 'download'
  | 'network'
  | 'stroke';

/**
 * One step of a probe (`reach → act → observe`). Deliberately small, optional
 * surface — the bash orchestrator drives a real `npx playwright` subshell, not a
 * JS DOM stub. Concept/VQA v3 extends it from "L2 flow step" into the full probe
 * grammar; legacy `{action, url, selector, value, ms, label}` steps still validate.
 */
export interface VisualTestFlowStep {
  /** What this step does. See `ProbeStepAction`. */
  action: ProbeStepAction;
  /** For `navigate` — relative URL ("/", "/foo"); absolute URLs rejected. */
  url?: string;
  /** For `click`/`fill`/`select`/`drag`/`upload`/`download` — DOM selector. */
  selector?: string;
  /** For `fill`/`select` — value to type/choose; for `upload`/`download` — file path. */
  value?: string;
  /** For `wait`/`clock` — milliseconds. */
  ms?: number;
  /** For `screenshot` — short label that becomes part of the PNG filename. */
  label?: string;

  // ── VQA v3 interaction grammar (E2.1) ──
  /** For `press`/`hold` — key name, e.g. 'Space', 'ArrowLeft', 'Enter'. */
  key?: string;
  /** For `pointer`/`tap`/`drag` — viewport coordinates. */
  x?: number;
  y?: number;
  /** For `clock` — install (freeze), fastForward (jump), or runFor (advance). */
  clockMode?: 'install' | 'fastForward' | 'runFor';

  // ── L2-state `assert` oracle (FR-4) ──
  /** For `assert`/`seed` — JSON-path into the harness snapshot, e.g. 'snapshot.gameState'. */
  expr?: string;
  /** For `assert` — comparison operator. */
  op?: AssertOp;
  /** For `assert` — expected value (compared per `op`). */
  expected?: string | number | boolean;

  // ── VQA v3 Phase 2 — agentic event-driven verbs ──
  /** For `assert`/`waitForEvent`/`repeat` — max time to wait/poll (ms). */
  timeoutMs?: number;
  /** For `repeat` — the inner action to repeat (a press/hold/pointer/tap/click/wait). */
  step?: VisualTestFlowStep;
  /** For `repeat` — the until-condition (JSON-path into the harness snapshot). */
  untilExpr?: string;
  /** For `repeat` — until-condition operator. */
  untilOp?: AssertOp;
  /** For `repeat` — until-condition expected value. */
  untilExpected?: string | number | boolean;
  /** For `repeat` — safety caps so the loop is bounded. */
  maxIterations?: number;
  budgetMs?: number;
  /** For `repeat` — delay between iterations (ms). */
  intervalMs?: number;
  /** For `force` — the status to jump to (e.g. 'over', 'win'). */
  status?: string;

  // ── H10 coverage-class grammar gaps ──
  /** For `viewport` — width/height. */
  w?: number;
  h?: number;
  /** For `network` — connectivity mode. */
  network?: 'offline' | 'online';
  /** For `stroke` — continuous-gesture path (touch/pen). */
  points?: Array<{ x: number; y: number }>;
}

export interface VisualTestDef {
  id: string; // e.g., "VT-S5-1"
  criteriaRef: string; // which AC this tests
  description: string; // what to verify
  setup: string; // how to get to the testable state
  action?: string; // user interaction to simulate (legacy single-action)
  expect: string; // what the result should look like

  // ── Pipeline v2.0 PR-8 (Q3.1) — three-level routing ────────────────
  /** Routing level. Optional in source; auto-classified at qa-aggregate
   *  if missing. Required after the contract-approval gate. */
  level?: VisualTestLevel;
  /** Was the level operator-overridden vs. auto-classified? Set when the
   *  operator changes the level in the contract review UI. */
  levelOverridden?: boolean;

  // ── Pipeline v2.0 PR-8 (Q2.2) — schema-fixed viewport ──────────────
  /**
   * Viewport in `WIDTH,HEIGHT` form (commas, NOT 'x'). Bash converts to
   * playwright's `--viewport-size=W,H` flag. Schema-level format frees the
   * LLM from getting the flag string right (Problem #5 in the forensic).
   * Validated by `parseVisualTestViewport`.
   */
  viewport?: string;

  // ── L1-specific (single screenshot) ────────────────────────────────
  screenshot?: {
    /** DOM selector to capture (`#root` if omitted). */
    selector?: string;
    /** `'load'` | `'domcontentloaded'` | `'networkidle'` (passes to playwright). */
    waitFor?: string;
  };

  // ── L2-specific (multi-step flow) ──────────────────────────────────
  flow?: VisualTestFlowStep[];
  /** Extra judge-prompt text the L2 Sonnet invocation prepends to its
   *  rationale request. Lets the test author specify "compare these two
   *  screenshots and look for X" without re-explaining the flow. */
  judge?: string;

  // ── L0-specific (bash matchers) ────────────────────────────────────
  /** Relative URL to fetch. Defaults to `/` if absent. */
  url?: string;
  /** Console-error patterns the test EXPLICITLY tolerates (e.g.,
   *  `["webpack-dev-server.*HMR"]`). Anything not matching is a fail. */
  consoleErrorAllow?: string[];
  /** Page-source substrings that MUST appear (any one match passes). */
  expectText?: string[];

  // ── Per-test budget overrides (Q5.1) ───────────────────────────────
  /** Wall-clock budget in seconds. Defaults from level. Daemon kills LLM
   *  invocation on overage and marks the test `uncertain`. */
  budgetWallclockSec?: number;
  /** Cost budget in USD. Same kill semantics. L0 has no cost so this is a
   *  no-op there; meaningful for L1/L2. */
  budgetCostUsd?: number;
}

/**
 * Pipeline v2.0 PR-8 (Q5.3) — per-test verdict from a QA run.
 *
 * Three-state: pass / fail / uncertain. Uncertain happens when:
 *   • Per-test budget exceeded (kill at the daemon).
 *   • LLM judge returned non-PASS, non-FAIL (e.g., Haiku says "I cannot
 *     determine from this screenshot"); the operator decides.
 */
export interface VisualTestResult {
  testId: string;
  level: VisualTestLevel;
  /** PASS | FAIL | UNCERTAIN | SKIPPED-BUDGET | ERRORED */
  verdict: 'pass' | 'fail' | 'uncertain' | 'skipped-budget' | 'errored';
  /** One-line rationale from the bash check or LLM judge. */
  rationale?: string;
  /** S3 URL for the per-test screenshot (L0/L1) or first flow screenshot (L2). */
  screenshotUrl?: string;
  /** Cost in USD attributed to this test (LLM call price; 0 for L0). */
  costUsd?: number;
  /** Wall-clock in milliseconds. */
  durationMs?: number;
}

// ── Testing profile & review steps ──

export interface TestingProfile {
  hasBrowserTests: boolean;
  viewport?: string; // e.g., "800x600"
  interactionModel?: string; // e.g., "keyboard", "mouse", "touch"
}

export interface ReviewStep {
  step: string; // e.g., "visual_qa", "po_review"
  status: 'pending' | 'running' | 'passed' | 'failed';
  jobId?: string;
  completedAt?: string;
}

// ── Story ──

/**
 * Concept v2 — an AC-mapped task in the DEV checklist. `acRefs` ties each task
 * to the acceptance criteria it satisfies (BMAD `create-story` grade).
 */
export interface StoryTask {
  id: string; // "T1"
  text: string;
  acRefs: string[]; // e.g. ["AC-S1-1"] — which ACs this task satisfies
  done?: boolean; // DEV flips during execution
}

/**
 * Concept v2 — a citation from a story into an upstream artifact section or the
 * boilerplate test-harness seam. `section` is validated against the artifact's
 * section manifest (Concept §6.2 — wired in Epic E4), or, for `source: 'harness'`,
 * a JSON-path into `__harness.schema.json` (e.g. "snapshot.gameState").
 */
export interface StoryReference {
  source: 'prd' | 'architecture' | 'ux' | 'harness';
  section: string;
  note?: string; // why this story cites it
}

export interface EpicStory {
  storyId: string;
  order: number;
  title: string;
  description: string; // full story text including AC
  status: StoryStatus;
  /**
   * F6 — why a story landed in `status === 'skipped'`. 'skipped-budget' is
   * written by the daemon's wave budget gate (`enforceWaveBudgetGate`) when a
   * wave is blocked because the plan's cost ceiling was reached. The
   * wave-reducer treats any 'skipped' story as terminal (does not block the
   * wave, never relaunches it). Absent for non-skipped stories.
   */
  skippedReason?: 'skipped-budget';
  jobId?: string; // linked pipeline job ID
  dependsOn?: string[]; // story IDs this depends on
  wave?: number; // computed wave for parallel execution (0-indexed)
  hasBrowserTests?: boolean; // derived from criteria
  criteria?: AcceptanceCriterion[]; // structured criteria
  visualTests?: VisualTestDef[]; // populated by Dev agent

  // ── Concept v2 (BMAD-grade definition) — all optional; legacy stories and
  //    `prototype` runs are unaffected. Carried through the Story Context Pack
  //    (Epic E3) and consumed by the DEV/REVIEWER agents at Start development. ──
  userStory?: { role: string; action: string; benefit: string }; // As a / I want / So that
  technicalNotes?: string; // impl guidance, affected components, constraints
  tasks?: StoryTask[]; // AC-mapped checklist for the DEV agent
  references?: StoryReference[]; // citations into prd.md / architecture.md / ux-spec.md / harness

  // ── Compilation metadata (MY-2 Story Compilation Pipeline) ──
  compilationStatus?: CompilationStatus;
  compilationStartedAt?: string;
  compilationCompletedAt?: string;
  compilationArticleCounts?: CompilationArticleCounts;

  // ── Work summary (Epic B.6) ──
  // Verbatim `---WORK_SUMMARY--- … ---END_WORK_SUMMARY---` block extracted
  // from the DEV / retry agent. Persisted by the daemon after each dev /
  // retry step that successfully extracts a WORK_SUMMARY (last-write-wins).
  // Sibling stories in the same wave read this via the Story Context Pack
  // (`prevWorkSummaries`) so they don't have to re-discover what shipped.
  workSummary?: string;
  /** ISO timestamp of the last `workSummary` write — for debugging only. */
  workSummaryAt?: string;

  /**
   * v2.6 M5 (2026-06-11) — how this story came to exist. Absent = authored
   * by the PM plan. 'wave-vqa-fix' = auto-minted by the wave gate's
   * fix-forward path: a judge panel confirmed a visual failure on the
   * merged candidate, the capped in-gate fixer couldn't clear it, green
   * advanced anyway, and this story carries the handoff packet through the
   * normal story pipeline. Cap: ONE per owning story per plan (recurrence
   * escalates to the operator instead).
   */
  origin?: 'wave-vqa-fix';

  // ── Touch-point inference (Epic 3) ──
  touchPoints?: string[];
  /**
   * D3-2 (2026-06-22) — the source files this story's DEV agent ACTUALLY edited,
   * as measured post-DEV by the dev-scope gate (`dev-scope-check`, story-pipeline).
   * Distinct from `touchPoints` (what the PM *declared*): the gate enforces
   * against the declared set, and this records the *measured* set so a future
   * wave computation serializes stories that genuinely collide on a file neither
   * declared. NEVER fed back into the gate's declared set (that would rubber-stamp
   * an out-of-scope edit); it only widens collision detection in
   * `computeStoryWavesWithTouchPoints`. Persisted via `updateStoryActualTouchPoints`.
   */
  actualTouchPoints?: string[];
  /**
   * Story D.1 — file paths or glob patterns the story MUST NOT modify. The
   * REVIEWER pre-fills `scope-forbidden: fail — modified <file> in
   * forbiddenAreas` ACs in the structured `---REVIEW_CRITERIA---` block when
   * a story's diff overlaps any entry here. Optional; absent → no
   * forbidden areas (the default for legacy stories).
   */
  forbiddenAreas?: string[];
  complexity?: StoryComplexity;
  reviewRigor?: ReviewRigor;
  inferenceMetadata?: InferenceMetadata;

  // ── Blocker state (Epic 5) ──
  // `blocker` is populated while status === 'blocked'. It is cleared by a
  // successful resolve-blocker call; the operator's action is appended to
  // `resolutionHistory` as an audit record.
  blocker?: BlockerRecord;
  resolutionHistory?: BlockerResolutionRecord[];
}

// ── Epic ──

export interface EpicWorkflow {
  epicId: string;
  /** FK to Plan (Epic 17). Required for new epics; legacy epics may omit it (retired post-migration). */
  planId?: string;
  /** Epic-level dependency graph — IDs of epics that must complete before this one can start (Story 17.4). */
  dependsOnEpics?: string[];
  /** Computed from `dependsOnEpics` — the plan-wave number. 0 = runs first. */
  epicWave?: number;
  title: string;
  description: string;
  acceptanceCriteria: string;
  /** Concept v2 — value statement ("why this epic exists"; BMAD names epics by value). Optional. */
  goal?: string;
  /** Concept v2 — PRD functional-requirement ids this epic covers (e.g. ["FR-3","FR-7"]); traceability spine for the §8 gate + §12 overlay. */
  requirementRefs?: string[];
  workingDir: string;
  status: EpicStatus;
  stories: EpicStory[];
  testingProfile?: TestingProfile; // overall testing config
  reviewSteps?: ReviewStep[]; // dynamic review checklist
  waveBuildJobs?: Record<string, string>; // wave number → build-check job ID
  // snake3 (2026-06-10) — per-wave transient-retry counter. The reducer
  // re-mints a wave-merge job when it failed for an INFRA reason
  // (waveMergeResult.transient: resolver auth death, ENOSPC, non-content
  // git errors), bounded by this counter so a persistently-failing wave
  // still escalates to the operator after 2 automatic retries.
  waveBuildRetries?: Record<string, number>; // wave number → transient retries used
  devModel?: string;
  devEffort?: string;
  reviewerModel?: string;
  reviewerEffort?: string;
  yoloMode?: boolean;
  qaJobId?: string;
  poJobId?: string;
  deployJobId?: string;
  deployUrl?: string;
  deployedAt?: string;

  // ── Epic Orchestrator (Arch Doc §3, Epic 4) ──
  // When true, the `/start` endpoint creates a single `phase: 'epic-dev'`
  // job that runs the entire epic through the orchestrator. When false or
  // absent, the Labs UI falls back to legacy per-story buttons.
  useEpicOrchestrator?: boolean;
  orchestratorJobId?: string;

  createdAt: string;
  updatedAt: string;
  createdBy: string;
}
