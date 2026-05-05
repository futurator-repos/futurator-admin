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

export interface AcceptanceCriterion {
  id: string; // e.g., "AC-1"
  text: string; // plain English description
  needsBrowser: boolean; // does verification require a running browser?
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
 * One step of an L2 Playwright flow. Deliberately small surface — the bash
 * orchestrator drives a real `npx playwright` subshell, not a JS DOM stub.
 */
export interface VisualTestFlowStep {
  /** What this step does in the headless browser. */
  action: 'navigate' | 'click' | 'wait' | 'screenshot' | 'fill';
  /** For `navigate` — relative URL ("/", "/foo"); absolute URLs rejected. */
  url?: string;
  /** For `click`/`fill` — DOM selector. */
  selector?: string;
  /** For `fill` — value to type. */
  value?: string;
  /** For `wait` — milliseconds. */
  ms?: number;
  /** For `screenshot` — short label that becomes part of the PNG filename. */
  label?: string;
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

export interface EpicStory {
  storyId: string;
  order: number;
  title: string;
  description: string; // full story text including AC
  status: StoryStatus;
  jobId?: string; // linked pipeline job ID
  dependsOn?: string[]; // story IDs this depends on
  wave?: number; // computed wave for parallel execution (0-indexed)
  hasBrowserTests?: boolean; // derived from criteria
  criteria?: AcceptanceCriterion[]; // structured criteria
  visualTests?: VisualTestDef[]; // populated by Dev agent

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

  // ── Touch-point inference (Epic 3) ──
  touchPoints?: string[];
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
  workingDir: string;
  status: EpicStatus;
  stories: EpicStory[];
  testingProfile?: TestingProfile; // overall testing config
  reviewSteps?: ReviewStep[]; // dynamic review checklist
  waveBuildJobs?: Record<string, string>; // wave number → build-check job ID
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
