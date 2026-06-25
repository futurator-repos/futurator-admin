/**
 * Ultracode-Reverse bench — run record types.
 *
 * One row per bench run: an operator submits an intent; the system runs CASE 1
 * (the real Claude Code `ultracode` planner, captured + halted before fan-out)
 * and CASE 2 (our reverse-engineered projector) on the same intent, then scores
 * both with the `spikes/ultra-reverse` engine. The scoring contracts reuse the
 * shared `ScorecardSlice` shape so these rows drop into the existing scorecard UI.
 *
 * Lifecycle (daemon is the only writer past QUEUED):
 *   QUEUED (API) → CAPTURING → HALTED → SCORING → COMPLETE ; any step → ERROR
 */

import type { ScorecardSlice } from '../scorecard/types';

export type UltracodeRunStatus =
  | 'QUEUED'
  | 'CAPTURING'
  | 'HALTED'
  | 'SCORING'
  | 'COMPLETE'
  | 'ERROR';

/** Per-engine status, surfaced as the HALTED badge in the dual live view. */
export type UltracodeSideStatus = 'PENDING' | 'RUNNING' | 'HALTED' | 'COMPLETE' | 'ERROR';

export type UltracodeTarget = 'greenfield' | 'brownfield';
export type UltracodeRigor = 'prototype' | 'mvp' | 'production';

/** The known fairness confound (strategy §8.1) — stamped on every run, never silent. */
export const ULTRACODE_CONFOUND = 'case2-cost-tiered-chain' as const;

/**
 * The full scored result. For the M2 path this is stored inline on the row (it is
 * small); from M3 the large artifacts (captured scriptJs, per-rep DecisionPlans)
 * move to S3 and only `scorecardS3Key` + scalars remain on the row.
 */
export interface UltracodeScorecard {
  /** Structural diff (Scorer 1): pattern_match + dag_shape (slice) or the full metric set. */
  structural: { score: number; perMetric: Record<string, number> };
  /** Guardrail uplift (Scorer 3) — Case-2-only axis. Absent if not computed. */
  guardrail?: { uplift: number; sub: Record<string, number> };
  /** Judge panel (Scorer 2) — present only when the live judge ran. */
  judge?: {
    perAxis: Record<string, { case1: number | null; case2: number | null }>;
    notes: string[];
  };
  /** The emitted ScorecardSlice rows (reuse the shared scorecard contract). */
  slices: ScorecardSlice[];
  /** Threshold verdict (rubric); e.g. 'case2-matches' | 'case2-gaps' | 'case2-wins'. */
  verdict?: string;
  /** Ranked gaps that feed the distillation loop. */
  observations?: string[];
}

/** A subagent the plan spawns (parsed from the captured script). */
export interface UltracodePlanAgent {
  role: string;
  hasSchema: boolean;
  model: string;
  isolation: 'none' | 'worktree';
  agentType?: string | null;
  effort?: string | null;
  /** The agent's prompt (capped) so the UI can show what each subagent is told to do. */
  prompt?: string;
  /** True when the prompt is composed by a fn/expr rather than a string literal. */
  promptDynamic?: boolean;
}

/** One phase of the plan (parsed). */
export interface UltracodePlanPhase {
  name: string;
  mode: 'sequential' | 'parallel-barrier' | 'streaming';
  fanOut: { axis: string; width: number | 'dynamic' } | null;
  agents: UltracodePlanAgent[];
  barrierReason?: string;
}

/** The normalized DecisionPlan IR both engines reduce to (mirrors daemon/lib/ultracode). */
export interface UltracodeDecisionPlan {
  pattern: string;
  qualityPatterns: string[];
  phases: UltracodePlanPhase[];
  verify: { present: boolean; kind: string };
  reduceSteps: number;
  earlyExit: boolean;
  edges: Array<[string, string]>;
  source: string;
  extraction: { lossy: string[] };
}

export interface UltracodeRun {
  runId: string;
  operatorId: string;
  status: UltracodeRunStatus;

  // ── inputs ──
  intent: string;
  target: UltracodeTarget;
  rigor: UltracodeRigor;
  /** N repetitions; planning is stochastic so the bench compares distributions. */
  reps: number;

  /** FK to the enqueued daemon job (== runId). Absent for the synchronous M2 path. */
  jobId?: string;

  // ── per-engine progress ──
  case1Status: UltracodeSideStatus;
  case2Status: UltracodeSideStatus;
  case1Pattern?: string;
  case2Pattern?: string;

  // ── scored result (scalars on the row; full object inline for M2, S3 from M3) ──
  structuralScore?: number;
  guardrailUplift?: number;
  verdict?: string;
  /** Capped summary (~10) for the corpus list without reading the full scorecard. */
  summarySlices?: ScorecardSlice[];
  /** Inline full scorecard (M2). Mutually exclusive with `scorecardS3Key` (M3+). */
  scorecard?: UltracodeScorecard;
  scorecardS3Key?: string;
  artifactKeys?: string[];

  // ── captured artifacts (representative rep) for the UI detail view ──
  /** Parsed plan from native ultracode (Case 1): phases, subagents, fan-out. */
  case1Plan?: UltracodeDecisionPlan;
  /** Parsed plan from our meta-prompt (Case 2). */
  case2Plan?: UltracodeDecisionPlan;
  /** Raw captured workflow script (Case 1). */
  case1Script?: string;
  /** Raw generated workflow script (Case 2). */
  case2Script?: string;

  // ── provenance / honesty ──
  confound: typeof ULTRACODE_CONFOUND;
  claudeVersion?: string;
  promptVersion?: string;
  /** Reps excluded because capture left agents running (agentCount>0). */
  taintedReps?: number;
  errorMessage?: string;

  // ── timestamps ──
  createdAt: string;
  updatedAt: string;
  /** Epoch SECONDS — DynamoDB TTL (90 days). */
  expiresAt: number;
}

/** Compact row for the corpus/history list (no heavy scorecard payload). */
export interface UltracodeRunSummary {
  runId: string;
  intent: string;
  target: UltracodeTarget;
  rigor: UltracodeRigor;
  reps: number;
  status: UltracodeRunStatus;
  case1Status: UltracodeSideStatus;
  case2Status: UltracodeSideStatus;
  structuralScore?: number;
  guardrailUplift?: number;
  verdict?: string;
  createdAt: string;
}

export function toRunSummary(r: UltracodeRun): UltracodeRunSummary {
  return {
    runId: r.runId,
    intent: r.intent,
    target: r.target,
    rigor: r.rigor,
    reps: r.reps,
    status: r.status,
    case1Status: r.case1Status,
    case2Status: r.case2Status,
    structuralScore: r.structuralScore,
    guardrailUplift: r.guardrailUplift,
    verdict: r.verdict,
    createdAt: r.createdAt,
  };
}
