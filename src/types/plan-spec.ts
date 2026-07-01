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
export type TestBindingStatus = 'unbound' | 'bound' | 'passing' | 'failing';

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
