/**
 * Plan Retrospect — frontend type mirror (spec §4d / §5).
 *
 * KEEP IN SYNC with `functions/shared/scorecard/types.ts`. These are the
 * operator-facing shapes the Retrospect tab renders. The word "scorecard"
 * survives ONLY in internal identifiers (the API segment `/scorecard/`, the
 * DDB table, this file's name); every USER-FACING string says "Plan
 * Retrospect / Reality Check / The Assessor" (spec §1).
 *
 * Stage ids here use the BACKEND scorecard `StageId` values
 * (`development`/`deployment`/`publish`), NOT the dashboard's pipeline stage
 * ids (`developing`/`deploy`/`published`). The Retrospect tab maps its own
 * rows; the rest of the dashboard is unaffected.
 */

/** The six rubric stages (`overview` carries pipeline-health + grade band). */
export type StageId = 'concept' | 'development' | 'qa' | 'deployment' | 'publish' | 'overview';

/** Which engine produced a slice — `deterministic` (Lambda) or `assessor` (LLM). */
export type SliceEngine = 'deterministic' | 'assessor';

/**
 * The traffic-light verdict. `⚪` = needs-instrumentation / N/A: the evidence
 * is NOT available from the Lambda inputs, so the criterion is excluded from
 * the rollup. The card renders its `[needs-instrumentation: …]` note.
 */
export type Verdict = '🟢' | '🟡' | '🔴' | '⚪';

/** A pointer to where the evidence lives — never a data dump (spec §5). */
export interface EvidenceRef {
  kind: 'forensic' | 'ddb' | 'graph' | 'log' | 'artifact' | 'report';
  /** A path/anchor — e.g. `aggregate.byCategory.compile.count`, `orphans.json#status`. */
  ref: string;
}

/**
 * A reference to a fix that addresses a criterion. An IE maps to one-or-more of
 * these via the rubric §8 map, each rendered with its OWN shipped/open state.
 * `kind:'story'` is for IE28 → Story 4.2 (a Story, not an F).
 */
export interface FixRef {
  /** Fix id (`F14`) or story ref (`4.2`). */
  id: string;
  kind: 'F' | 'story';
  status: 'open' | 'shipped' | 'verified';
  /** Commit SHA when shipped. */
  sha?: string;
  /** Enabling dependencies (e.g. IE28's Story 4.2 depends on F26). */
  dependsOn?: string[];
}

/** One graded criterion (spec §4d). `score` is `null` for `⚪`. */
export interface ScorecardSlice {
  /** e.g. "D-CC1", "SK2", "OV11". */
  criterionId: string;
  stage: StageId;
  /** 0–4 on the rubric scale; `null` for `⚪`. */
  score: 0 | 1 | 2 | 3 | 4 | null;
  verdict: Verdict;
  /** Numeric for ratios/counts; string when unreconciled / N/A / a label. */
  value: number | string;
  evidence: EvidenceRef;
  /** Optional note — carries `[needs-instrumentation: …]` for `⚪`. */
  note?: string;
  /** Detected IEs this criterion reproduces (rubric §8 ids). */
  ieIds: string[];
  /** F-findings / stories that address it, with per-finding shipped/open state. */
  fixIds: FixRef[];
  /** Cost honesty flag — `unreconciled` when a cost criterion is a lower bound (OV4). */
  confidence?: 'reconciled' | 'unreconciled';
  engine: SliceEngine;
}

/**
 * One generated so-what action per red/yellow criterion (spec §4c). Pushable to
 * the fixes-plan backlog or the Reflector inbox (SQ2).
 */
export interface ImprovementAction {
  /** The criterionId that triggered this action. */
  redCriterion: string;
  ieIds: string[];
  fixIds: FixRef[];
  status: 'open' | 'pushed';
  /** Where a pushed action landed. */
  target?: 'fixes-plan' | 'reflector-inbox';
  /** When no fix maps, a drafted candidate finding the operator can ratify. */
  draftFinding?: string;
}

/** §9 grade band. */
export type GradeBand = 'A' | 'B' | 'C' | 'D' | 'F';

/**
 * The full Reality Check for a plan — the composed output the UI renders
 * (spec §3 / §7.1 `GET /plans/:id/scorecard`). All stored slices (latest
 * `rubricVersion` per stage) + the overview rollup + improvement actions.
 */
export interface RealityCheck {
  planId: string;
  /** Every graded slice across all analyzed stages. */
  slices: ScorecardSlice[];
  /** 0–1 weighted pipeline health (only meaningful once Overview is scored). */
  pipelineHealth: number | null;
  gradeBand: GradeBand | null;
  /** vs the v0 pacman3 baseline only (Phase 1–2). */
  topRegressions: string[];
  topWins: string[];
  actions: ImprovementAction[];
  /** The ruler this was graded against. */
  rubricVersion: string;
  /** Cost-honesty flag (OV4). */
  confidence?: 'reconciled' | 'unreconciled';
  /** Which stages have a stored verdict (so the rail can mark "analyzed"). */
  analyzedStages: StageId[];
}

/**
 * The response of `POST /plans/:id/scorecard/:stage/run`. Deterministic-only
 * stages resolve inline (`status:'scored'` + the slices). Stages with `[LLM]`
 * criteria return `status:'assessing'` + a `jobId` for the UI to stream via
 * StoryLiveOutput (spec §7.1).
 */
export type RunScorecardStageResponse =
  | { status: 'scored'; stage: StageId; slices: ScorecardSlice[] }
  | { status: 'assessing'; stage: StageId; jobId: string; slices: ScorecardSlice[] };
