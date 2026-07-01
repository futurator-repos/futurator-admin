/**
 * plan-spec — the Mycelium → dev handoff contract (development-plan §3).
 *
 * The single chokepoint between CONCEPT/SPEC (Mycelium converges a `planSpec`)
 * and DEV (the daemon pulls one StoryNode at a time the instant its `depends_on`
 * closure is satisfied). The StoryNode is the unit of schedule/spec/completion;
 * an AgentJob is the unit of execution (one minted per ready StoryNode).
 *
 * The three edge classes each do double duty:
 *   • depends_on  → schedules (Kahn ready-frontier)
 *   • touches     → gates scope + isolation + merge-conflict grouping
 *   • testBinding → gates completion (all bound deterministic ACs passing ⇒ done)
 */

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

/**
 * AC classification. Only `advisory-security` can block on a reviewer fail;
 * `deterministic` passes iff its test binding is passing; `advisory-taste`
 * becomes an operator note, never a retry.
 */
export type AcClass = 'deterministic' | 'advisory-taste' | 'advisory-security';

/** A bound acceptance criterion = the legacy AC + binding + classification. */
export interface BoundAcceptanceCriterion {
  id: string;
  text: string;
  needsBrowser?: boolean;
  given?: string;
  when?: string;
  then?: string;
  thenObservable?: string;
  verify?: 'build' | 'appearance' | 'state' | 'behavior' | 'manual';
  manualReason?: string;
  // ── net-new ──
  testBinding: TestBinding;
  acClass: AcClass;
  /** Optional link to a delivery user-journey this AC validates. */
  validatesUjId?: string;
}

/** Pointer into a durable spec_shard; contentHash is BOTH cache key + drift detector. */
export interface SpecShardRef {
  shardId: string;
  s3Uri: string;
  /** SHA-256 of the shard content. */
  contentHash: string;
  section?: string;
}

export type StoryComplexity = 'trivial' | 'standard' | 'complex' | 'architectural';

export interface StoryNode {
  /** GLOBALLY stable, Mycelium-issued. Not epic-local. */
  storyId: string;
  cohort: { epicId: string; epicTitle?: string; requirementRefs?: string[] };
  title: string;
  intent?: string;
  acceptanceCriteria: BoundAcceptanceCriterion[]; // ≥1
  /** Global story ids that gate dispatch. */
  depends_on: string[];
  /** Globs that gate scope + isolation + conflict grouping. ≥1 (or EPIC_WIDE sentinel). */
  touches: string[];
  /** Hard-deny globs. The derived forbidden set is computed at dispatch. */
  forbiddenAreas?: string[];
  specShardRef?: SpecShardRef;
  complexity: StoryComplexity;
  verifyIntent?: string;
}

export interface PlanSpec {
  schemaVersion: 'plan-spec/1';
  planId: string;
  appId: string;
  planSlug: string;
  rigor: 'prototype' | 'mvp' | 'production';
  convergedAt: string;
  myceliumPlanSpecId: string;
  stories: StoryNode[]; // ≥1
}

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
 * Deterministic completion verdict written by the story-dev pipeline.
 * Mirrors the return shape of `evaluateCompletion` in completion-gate.mjs.
 */
export interface StoryVerdict {
  done: boolean;
  status: 'done' | 'failing' | 'blocked' | 'needs-human';
  /** AC ids that failed their deterministic bound test. */
  failing: string[];
  /** AC ids blocked by an advisory-security reviewer fail. */
  blocking: string[];
  /** AC ids with non-blocking advisory-taste reviewer fails. */
  attention: string[];
  /** AC ids awaiting manual verification. */
  pending: string[];
  /** Human-readable failure reasons (one per blocking issue). */
  reasons: string[];
}

/** The persisted plan-spec-graph row (StoryNode + scheduling/lifecycle columns). */
export interface StoryNodeRow extends StoryNode {
  planId: string;
  appId: string;
  state: StoryNodeState;
  /** depends_on.length at ingest; atomically decremented as deps finish. */
  unblockedDepsCount: number;
  /** topological level — UI/merge grouping. */
  cohortBatch: number;
  jobId?: string;
  claimOwner?: string;
  claimToken?: string;
  claimExpiresAt?: string;
  version: number;
  createdAt: string;
  updatedAt: string;
  // ── Runtime write-back (G1 — story-dev-pipeline run results) ──────────────
  /** HEAD SHA of the per-story commit (staleness guard for bound-AC tests). */
  commitSha?: string;
  /** Completion verdict from evaluateCompletion (deterministic oracle). */
  verdict?: StoryVerdict;
  /** Total agent cost in USD for the last dev run. */
  costUsd?: number;
  /** Input token count for the last dev run. */
  inputTokens?: number;
  /** Output token count for the last dev run. */
  outputTokens?: number;
  /** Wall-clock duration of the last dev run in milliseconds. */
  durationMs?: number;
}
