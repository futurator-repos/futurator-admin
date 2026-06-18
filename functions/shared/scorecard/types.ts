// Plan Retrospect — shared scorecard contracts (the "spine")
//
// Every detector imports from this module. These are the contracts that
// rollup.ts, the composer, the Assessor job, and the repository all agree on.
//
// Naming note (rubric §0.2 / spec §1): the operator-facing names are
// "Plan Retrospect / Reality Check / The Assessor". The word "scorecard"
// survives ONLY in internal identifiers (this module path, the DDB table, the
// jobType, the repo functions, the /scorecard/ API segment). Do NOT rename
// these to retrospect/* — they are the storage/job contract.
//
// Sources:
//   - rubric §0.5/§0.8 output schema, §0.6 criteria index (scorer contract)
//   - plan-retrospect-spec §4d (ScorecardSlice), §4c (ImprovementAction)
//   - forensic-builder.ts (ForensicPayload / ForensicSkillsBlock primitives)

import type { Plan } from '../types/plan';
import type { EpicWorkflow } from '../types/epic-workflow';
import type { AgentEvent } from '../types/agent-orchestrator';
import type { TimerSlice } from '../timer/types';
import type { AggregationResult, CategorySummary } from '../timer/aggregator';
import type { ForensicSkillsBlock, CohortBaseline } from '../timer/forensic-builder';

// ── Engine / stage discriminators ────────────────────────────────────────────

/**
 * The six rubric stages (`overview` is the cross-cutting roll-up bucket that
 * carries pipeline-health + grade band, rubric §7/§9).
 */
export type StageId = 'concept' | 'development' | 'qa' | 'deployment' | 'publish' | 'overview';

/**
 * Which engine produced a slice. `deterministic` = the §4a Lambda scorer (no
 * LLM); `assessor` = The Assessor daemon agent job (§4b, the `[LLM]` rows).
 */
export type SliceEngine = 'deterministic' | 'assessor';

// ── Evidence ─────────────────────────────────────────────────────────────────

/**
 * A pointer to where the evidence lives — a forensic path, a DDB anchor, a
 * `_graph` report field, a daemon-log anchor, an artifact path, or a stage
 * report field. **Never a data dump** (rubric §0.8, spec §5: keeps DDB items
 * small; the UI dereferences `ref` on expand).
 */
export interface EvidenceRef {
  kind: 'forensic' | 'ddb' | 'graph' | 'log' | 'artifact' | 'report';
  /** A path/anchor — e.g. `aggregate.byCategory.compile.count`, `orphans.json#status`. */
  ref: string;
}

// ── Verdict / fix linkage ────────────────────────────────────────────────────

/**
 * The traffic-light verdict for a criterion. `⚪` = not-applicable /
 * needs-instrumentation: the evidence is NOT available from the Lambda inputs,
 * so the slice scores `null` and is **excluded from the rollup denominator**
 * (rubric §0.4, honesty guard spec §4a). Never fabricate a value to avoid `⚪`.
 */
export type Verdict = '🟢' | '🟡' | '🔴' | '⚪';

/**
 * A reference to a fix that addresses a criterion's red/yellow. An IE maps to
 * one-or-more of these via `ie-to-f-map.ts` (rubric §8). `kind:'story'` is for
 * IE28 → Story 4.2 (it maps to a Story, not an F — spec §4c case b).
 *
 *  - `status` is the reconciled shipped/open state (rubric §12 de-bias #3): a
 *    fix is `shipped` only when a real commit SHA exists; `verified` once
 *    re-checked on a later run.
 *  - `sha` is the commit it shipped in (when known).
 *  - `dependsOn` carries enabling deps (e.g. IE28's Story 4.2 depends on F26).
 */
export interface FixRef {
  /** Fix id (`F14`) or story ref (`4.2`). */
  id: string;
  kind: 'F' | 'story';
  status: 'open' | 'shipped' | 'verified';
  /** Commit SHA when shipped. */
  sha?: string;
  /** Enabling dependencies (other fix ids / story refs). */
  dependsOn?: string[];
}

// ── The working unit ─────────────────────────────────────────────────────────

/**
 * The internal working unit a detector (or the Assessor) emits per criterion.
 * The composer derives the stored rubric §0.5 view from a `ScorecardSlice[]`
 * (spec §4d mapping). `score` is `null` for `⚪` (needs-instrumentation / N/A).
 */
export interface ScorecardSlice {
  /** e.g. "D-CC1", "SK2", "OV11". */
  criterionId: string;
  /** The rubric stage this criterion belongs to. */
  stage: StageId;
  /** 0–4 on the rubric scale; `null` for `⚪` (excluded from the rollup). */
  score: 0 | 1 | 2 | 3 | 4 | null;
  verdict: Verdict;
  /** Numeric for ratios/counts; string when unreconciled / N/A / a label. */
  value: number | string;
  /** A ref/anchor — NOT a dump (§5). */
  evidence: EvidenceRef;
  /** Optional human note — carries `[needs-instrumentation: …]` for `⚪`. */
  note?: string;
  /** Detected IEs this criterion reproduces (rubric §8 ids). */
  ieIds: string[];
  /** F-findings / stories that address it, with per-finding shipped/open state. */
  fixIds: FixRef[];
  /**
   * Cost honesty flag (rubric §0.5 / spec §4a SQ4). `unreconciled` when a
   * cost-derived criterion can only report a lower bound (OV4 gap).
   */
  confidence?: 'reconciled' | 'unreconciled';
  /** Which engine produced this slice. */
  engine: SliceEngine;
}

// ── Improvement actions (composer output) ────────────────────────────────────

/**
 * One generated so-what action per red/yellow criterion (spec §4c / §3.3). The
 * composer collects every 🔴/🟡 slice, maps it to its fix(es), and emits one of
 * these. Pushable to the fixes-plan backlog or the Reflector inbox (SQ2).
 */
export interface ImprovementAction {
  /** The criterionId that triggered this action (e.g. "D-CC1"). */
  redCriterion: string;
  ieIds: string[];
  fixIds: FixRef[];
  status: 'open' | 'pushed';
  /** Where a pushed action landed. */
  target?: 'fixes-plan' | 'reflector-inbox';
  /** When no fix maps, a drafted candidate finding the operator can ratify. */
  draftFinding?: string;
}

// ── Detector input bag ───────────────────────────────────────────────────────

/**
 * Convenience accessor over `aggregate.byCategory` — `byCat('compile')` returns
 * the `{ totalMs, count }` summary (or a zero summary; the aggregator already
 * seeds every category, so this never returns undefined in practice).
 */
export type ByCat = (cat: string) => CategorySummary;

/**
 * The bag of inputs every detector reads. Assembled once by the §4a scorer
 * entrypoint and passed to each detector. Real types are reused where they
 * exist; fields that may be absent from the Lambda inputs are optional (a
 * detector that needs an absent input emits a `⚪` slice — spec honesty guard).
 */
export interface DetectorContext {
  planId: string;
  /** The plan row (counts, costs, timestamps, qaContractStatus, deployJobIds…). */
  plan: Plan;
  /** Resolved epic rows (stories[], waveBuildJobs, orchestratorJobId). */
  epics: EpicWorkflow[];
  /** Collected events across the plan's jobs (incl. retry-union — forensic primitive). */
  events: AgentEvent[];
  /** Timer slices for the plan (`sliceForPlan`). */
  slices: TimerSlice[];
  /** Per-category aggregation (`aggregateByCategory(slices)`). */
  aggregate: AggregationResult;
  /** Forensic skills block — null when no skill events were observed. */
  skills: ForensicSkillsBlock | null;
  /** Cohort baseline — null in Phase 1 (deterministic path skips cohort I/O). */
  cohort: CohortBaseline | null;
  /** Convenience accessor over `aggregate.byCategory`. */
  byCat: ByCat;

  // ── Optional inputs (absent ones drive `⚪` slices, never fabrication) ──
  /**
   * Parsed `knowledge/_graph/` reports (orphans.json / dead-code.json /
   * graph-snapshot.json). Absent when the Lambda lacks the S3 read or the
   * project has no graph yet → graph detectors emit `⚪`.
   */
  graphReports?: GraphReports;
  /** Parsed qa-report (claims table, per-test rationale, SCREENSHOTS_CAPTURED). */
  qaReport?: unknown;
  /** Parsed deploy report (`environments[].{activeJobId,smokeStatus,status}`). */
  deployReport?: unknown;
  /** `inbox/reflections.md` content / reflection rows (OV8/OV9). */
  reflections?: unknown;
  /**
   * Agent-spend rows for OV4 cost reconciliation (spec §4a honesty guard —
   * cost is NOT on events; it is walltime-derived in agent-spend rows).
   */
  agentSpendRows?: AgentSpendRow[];
}

/**
 * The three `knowledge/_graph/` report files, parsed (rubric §0.7 / spec §4a).
 * Each is optional so a partial read still scores what it can.
 */
export interface GraphReports {
  /** `graph-snapshot.json` — only `{projectId,generatedAt,nodeCount,edgeCount,nodes[],edges[]}`. */
  snapshot?: GraphSnapshot;
  /** `orphans.json` — `{status,orphanCount,hardFailCount,byKind,orphans[]}`. */
  orphans?: OrphansReport;
  /** `dead-code.json` — dead/zombie nodes (deleted source, never pruned). */
  deadCode?: DeadCodeReport;
  /** `.mycelium/ast-facts.json` — `{fileCount, …}` (separate root artifact). */
  astFacts?: { fileCount: number; [k: string]: unknown };
  /** Independent witness to plan source-file count for D-KC2's denominator. */
  projectSourceFileCount?: number;
}

export interface GraphSnapshotNode {
  id: string;
  projectId?: string;
  type?: string;
  [k: string]: unknown;
}
export interface GraphSnapshotEdge {
  source: string;
  target: string;
  [k: string]: unknown;
}
export interface GraphSnapshot {
  projectId: string;
  generatedAt: string;
  nodeCount: number;
  edgeCount: number;
  nodes: GraphSnapshotNode[];
  edges: GraphSnapshotEdge[];
}
export interface OrphansReport {
  status: 'pass' | 'fail';
  orphanCount: number;
  hardFailCount?: number;
  byKind?: Record<string, number>;
  orphans?: unknown[];
}
export interface DeadCodeReport {
  /** Zombie/deleted-source nodes that were never pruned. */
  nodes?: unknown[];
  count?: number;
}

/**
 * One agent-spend row (the daemon's walltime-derived cost; spec §4a). The
 * scorer sums these for OV4 reconciliation. Minimal shape — only the fields
 * the cost detectors read.
 */
export interface AgentSpendRow {
  planId?: string;
  jobId?: string;
  costUsd?: number;
  walltimeSec?: number;
  bucket?: string;
}
