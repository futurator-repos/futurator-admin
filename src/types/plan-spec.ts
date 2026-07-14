/**
 * plan-spec (client mirror) — the Labs3 view of the Pipeline-3 SDD graph.
 *
 * Echoes functions/shared/types/plan-spec.ts (the durable plan-spec-graph row)
 * for the browser bundle so Labs3 never reaches into `functions/**` at runtime.
 * Keep this file structurally in lock-step with the backend type: when the
 * StoryNodeRow contract changes, both move together (see migration note).
 *
 * The three edge classes each do double duty:
 *   • depends_on  → schedules (Kahn ready-frontier)
 *   • touches     → gates scope + isolation + merge-conflict grouping
 *   • testBinding → gates completion (all bound deterministic ACs passing ⇒ done)
 */

/** Lifecycle state mirrored onto the plan-spec-graph row. */
export type StoryNodeState =
  | 'blocked'
  | 'ready'
  | 'claimed'
  | 'developing'
  | 'merging'
  | 'verifying'
  | 'done'
  | 'failed';

/**
 * AC classification. Only `advisory-security` can block on a reviewer fail;
 * `deterministic` passes iff its test binding is passing; `advisory-taste`
 * becomes an operator note, never a retry.
 */
export type AcClass = 'deterministic' | 'advisory-taste' | 'advisory-security';

/** The ONE net-new field on an acceptance criterion. */
// Keep in sync with functions/shared/types/plan-spec.ts — 'misbound' (a
// verify:'state' AC whose bound test mocks the module under test) was missing
// here, so `Record<TestBindingStatus, …>` maps type-checked without it and the
// UI crashed at runtime on a real misbound AC (pacman3, 2026-07-14).
export type TestBindingStatus = 'unbound' | 'bound' | 'passing' | 'failing' | 'misbound';

export type TestKind = 'unit' | 'integration' | 'browser' | 'manual';

export interface TestBinding {
  status: TestBindingStatus;
  /** Test selector the bound test runs under (e.g. a vitest filter / probe id). */
  testRef?: string;
  testKind?: TestKind;
  /** Head SHA the last run executed against — the staleness guard. */
  lastRunSha?: string;
  lastRunAt?: string;
  detail?: string;
}

/** A bound acceptance criterion = the legacy AC + binding + classification. */
export interface BoundAcceptanceCriterion {
  id: string;
  text: string;
  acClass: AcClass;
  testBinding: TestBinding;
  given?: string;
  when?: string;
  then?: string;
  verify?: 'build' | 'appearance' | 'state' | 'behavior' | 'manual';
  needsBrowser?: boolean;
}

export type StoryComplexity = 'trivial' | 'standard' | 'complex' | 'architectural';

/**
 * Reality-Spine invariant validator status (mirrors the backend type): the
 * planner DECLARES a property of the domain data; the story AUTHORS an
 * executable validator; the gate RUNS it. Persisted WITH the row so a
 * resumed/retried job (and the UI) can see the authored binding.
 */
export type InvariantStatus = 'declared' | 'authored' | 'passing' | 'failing';

export interface InvariantValidator {
  /** Path to the executable validator (script or test) once authored. */
  ref?: string;
  kind?: 'script' | 'test';
  status: InvariantStatus;
  /** Head SHA the validator last ran against — the staleness guard. */
  lastRunSha?: string;
  lastRunAt?: string;
  detail?: string;
}

/** A planner-declared property of the domain data/contract that must hold. */
export interface Invariant {
  id: string;
  description: string;
  validator: InvariantValidator;
}

// ── Stage summaries (dossier B2) — structured per-stage artifacts on the row ──
// Written by the story-dev pipeline after each attempt so the stage pills can
// open an audit panel without re-parsing event prose. Size-capped at write time:
// preview ≤2000 chars/file, total stageSummaries JSON ≤48KB (previews first).

/** One file the Test-Author committed at RED (path + size + capped preview). */
export interface StageFileSummary {
  path: string;
  lines?: number;
  /** First ≤2000 chars of the file content (may be truncated further/removed
   *  under the 48KB row cap). */
  preview?: string;
}

/** Per-stage structured artifacts persisted on the story row. */
export interface StageSummaries {
  testAuthor?: {
    files: StageFileSummary[];
    redSha?: string;
    resumed?: boolean;
    bindings?: Record<string, { testRef: string; testKind?: string }>;
    invariantManifest?: Record<string, { ref: string; kind?: string }>;
    durationMs?: number;
  };
  implementer?: {
    attempts: Array<{
      attempt: number;
      commitSha?: string;
      filesChanged?: string[];
      durationMs?: number;
      tokens?: number;
    }>;
  };
  reviewer?: {
    verdicts?: Record<string, 'pass' | 'fail'>;
    needsHuman?: string[];
    ranAt?: string;
  };
  /** Populated by the compile pipeline (optional — absent until it runs). */
  compile?: { status?: string; detail?: string };
}

/**
 * Verdict written back by the completion gate after each dev attempt.
 * Mirrors the evaluateCompletion return shape from daemon/lib/completion-gate.mjs.
 */
export interface StoryVerdict {
  done: boolean;
  status: 'done' | 'failing' | 'blocked' | 'needs-human';
  /** AC ids whose deterministic bound-test did not pass (or is stale). */
  failing: string[];
  /** AC ids that blocked due to advisory-security reviewer fail. */
  blocking: string[];
  /** AC ids with advisory-taste reviewer fail (non-blocking operator note). */
  attention: string[];
  /** AC ids with unresolved manual checks. */
  pending: string[];
  /** Human-readable reason per failing/blocking entry. */
  reasons: string[];
}

/** The persisted plan-spec-graph row (StoryNode + scheduling/lifecycle columns). */
export interface StoryNodeRow {
  /** GLOBALLY stable, Mycelium-issued. Not epic-local. */
  storyId: string;
  planId: string;
  appId: string;
  cohort: { epicId: string; epicTitle?: string; requirementRefs?: string[] };
  title: string;
  intent?: string;
  acceptanceCriteria: BoundAcceptanceCriterion[]; // ≥1
  /** Global story ids that gate dispatch. */
  depends_on: string[];
  /** Globs that gate scope + isolation + conflict grouping. ≥1 (or EPIC_WIDE sentinel). */
  touches: string[];
  /** Hard-deny globs. */
  forbiddenAreas?: string[];
  complexity: StoryComplexity;
  /** Planner-declared properties of the domain data this story must satisfy.
   *  Persisted WITH validator state after each run (dossier A1). */
  invariants?: Invariant[];
  /** Planner-emitted short phase name (≤40 chars) — names the batch this story
   *  belongs to in the UI (fallback "Batch N" when absent). */
  phase?: string;
  state: StoryNodeState;
  /** depends_on.length at ingest; atomically decremented as deps finish. */
  unblockedDepsCount: number;
  /** topological level — UI/merge grouping. */
  cohortBatch: number;
  jobId?: string;
  claimOwner?: string;
  version: number;
  createdAt: string;
  updatedAt: string;

  // ── Post-run write-back fields (G1 story-persist / executeStoryDevJob) ──

  /** Git commit SHA after integrateStory completes. */
  commitSha?: string;
  /** Completion gate verdict from the last dev attempt. */
  verdict?: StoryVerdict;
  /** Approximate USD cost of the dev agent run (summed from stream events). */
  costUsd?: number;
  /** Prompt token count for the dev agent run. */
  inputTokens?: number;
  /** Completion token count for the dev agent run. */
  outputTokens?: number;
  /** Wall-clock milliseconds from spawn to close for the dev agent run. */
  durationMs?: number;
  /** Per-stage structured artifacts (test-author/implementer/reviewer/compile). */
  stageSummaries?: StageSummaries;
}

// ── Instinct loop (development-plan §5.5) — the Skills & Learnings surface. ──

/** One raw deterministic observation appended by the gate's posttool-observe sibling. */
export interface InstinctObservation {
  at: string;
  session: string;
  role?: string;
  tool?: string;
  target?: string;
  exitOutcome?: 'ok' | 'fail';
  scopeViolation?: boolean;
  gateTier?: string;
  sha?: string;
}

/** A scored instinct distilled from recurring negative-signal observations. */
export interface DistilledInstinct {
  id: string;
  key?: string;
  role?: string;
  tool?: string;
  touchesGlob?: string;
  enforcement: 'advisory' | 'gate' | 'test';
  confidence: number;
  support: number;
  text: string;
  status?: 'candidate' | 'active' | 'promoted';
}

/** A high-confidence instinct graduated to a Mycelium `Instinct` node. */
export interface PromotedInstinct {
  id: string;
  text: string;
  role?: string;
  touchesGlob?: string;
  enforcement: 'advisory' | 'gate' | 'test';
  confidence: number;
  support: number;
  status: 'promoted';
  promotedAt?: string;
}

/** One live-gate decision (audit-mode would-block or enforce-mode block). */
export interface GateBlockEvent {
  at?: string;
  session?: string;
  decision: 'allow' | 'audit' | 'block' | 'fact-force' | 'fact-force-cleared';
  enforce?: boolean;
  reason?: string;
  target?: string;
  risk?: { tier?: string; factors?: string[]; score?: number };
}

/** The bundled instinct-loop feed for one plan. Empty arrays render an empty panel. */
export interface InstinctFeed {
  observations: InstinctObservation[];
  distilled: DistilledInstinct[];
  promoted: PromotedInstinct[];
  gateBlocks: GateBlockEvent[];
}
