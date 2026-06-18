// Plan Retrospect — pure aggregation (rubric §0.3/§0.4 + §9 + §3.6 hard caps)
//
// Given graded ScorecardSlice[], roll up substage → stage → pipeline-health,
// apply the canonical hard caps, and assign a grade band. No I/O, no LLM —
// deterministic and unit-testable.
//
// Denominator rule (rubric §0.4): slices that are '⚪'/score===null
// (needs-instrumentation / N/A) are EXCLUDED from both numerator and
// denominator — they never drag a score down for being un-measurable.
//
// Hard caps (rubric §0.4 / §9, quoted verbatim in spec §3.6):
//   1. Any [MECH] criterion scoring 0 caps its STAGE at 0.5.
//   2. DP-S1 / P-S1 at 0 → overall grade F.
//   3. OV11 at 0 → caps the WHOLE pipeline (forces F).
//   (QA's Q-C6/Q-C7/Q-C9-at-0 cap is the same [MECH]-at-0 rule instantiated for
//    QA — handled by rule 1 since those are [MECH] criteria in CRITERIA_META.)

import type { ScorecardSlice, StageId } from './types';
import { CRITERIA_META } from './criteria-meta';

/** Stage weights for pipeline health (rubric §9). Sum = 100. */
export const STAGE_WEIGHTS: Record<StageId, number> = {
  concept: 15,
  development: 35,
  qa: 15,
  deployment: 10,
  publish: 10,
  overview: 15,
};

const MAX_SCORE = 4;
/** A [MECH]-at-0 caps its stage to this normalized score (rubric §0.4 rule 1). */
const MECH_ZERO_STAGE_CAP = 0.5;

/** True when a slice contributes to the rollup (excludes ⚪ / null). */
function isScored(s: ScorecardSlice): s is ScorecardSlice & { score: 0 | 1 | 2 | 3 | 4 } {
  return s.score !== null && s.verdict !== '⚪';
}

function weightOf(criterionId: string): number {
  return CRITERIA_META[criterionId]?.weight ?? 1;
}

function isMech(criterionId: string): boolean {
  return (CRITERIA_META[criterionId]?.tag ?? []).includes('MECH');
}

/**
 * Substage / arbitrary-set score = Σ(score×W) / Σ(W×4) → 0..1, ignoring ⚪/null.
 * Returns `null` when no scored slices remain (nothing to grade).
 */
export function substageScore(slices: ScorecardSlice[]): number | null {
  let num = 0;
  let den = 0;
  for (const s of slices) {
    if (!isScored(s)) continue;
    const w = weightOf(s.criterionId);
    num += s.score * w;
    den += w * MAX_SCORE;
  }
  if (den === 0) return null;
  return num / den;
}

/**
 * Stage score = the same weighted mean over all the stage's slices, with the
 * [MECH]-at-0 cap applied (rubric §0.4 rule 1): if any [MECH] criterion in the
 * stage scored 0, the stage is capped at 0.5.
 *
 * `null` when the stage has no scored slices.
 */
export function stageScore(slices: ScorecardSlice[]): number | null {
  const base = substageScore(slices);
  if (base === null) return null;
  const mechZero = slices.some((s) => isScored(s) && s.score === 0 && isMech(s.criterionId));
  return mechZero ? Math.min(base, MECH_ZERO_STAGE_CAP) : base;
}

export interface PipelineHealthResult {
  /** 0..1 weighted mean of the per-stage scores (stages with no slices skipped). */
  health: number;
  /** Per-stage normalized score (post-MECH-cap), null where unscored. */
  stageScores: Record<StageId, number | null>;
  /** True when a forced-F cap fired (DP-S1/P-S1/OV11 at 0). */
  forcedF: boolean;
  /** Which cap(s) forced F (criterion ids). */
  forcedFReasons: string[];
}

/**
 * Pipeline health = weighted mean of the per-stage scores (rubric §9 weights),
 * re-normalizing over only the stages that have scored slices. Then
 * `applyHardCaps` overlays the forced-F rules.
 */
export function pipelineHealth(slices: ScorecardSlice[]): PipelineHealthResult {
  const byStage = new Map<StageId, ScorecardSlice[]>();
  for (const s of slices) {
    const arr = byStage.get(s.stage) ?? [];
    arr.push(s);
    byStage.set(s.stage, arr);
  }

  const stageScores = {} as Record<StageId, number | null>;
  let num = 0;
  let den = 0;
  for (const stage of Object.keys(STAGE_WEIGHTS) as StageId[]) {
    const sc = stageScore(byStage.get(stage) ?? []);
    stageScores[stage] = sc;
    if (sc !== null) {
      const w = STAGE_WEIGHTS[stage];
      num += sc * w;
      den += w;
    }
  }

  const health = den === 0 ? 0 : num / den;
  const caps = applyHardCaps(slices, health);
  return {
    health: caps.health,
    stageScores,
    forcedF: caps.forcedF,
    forcedFReasons: caps.forcedFReasons,
  };
}

/**
 * Apply the forced-F hard caps (rubric §0.4 rules 2 & 3): DP-S1 / P-S1 / OV11
 * scoring 0 forces overall health to grade F. We express "force F" by clamping
 * health below the F band ceiling (0.40) so `gradeBand` returns 'F' while
 * preserving the (now-capped) numeric for display.
 *
 * The [MECH]-at-0 stage cap (rule 1) is applied in `stageScore`, not here.
 */
export function applyHardCaps(
  slices: ScorecardSlice[],
  health: number,
): { health: number; forcedF: boolean; forcedFReasons: string[] } {
  const FORCE_F_CRITERIA = ['DP-S1', 'P-S1', 'OV11'];
  const reasons: string[] = [];
  for (const s of slices) {
    if (s.score === 0 && s.verdict !== '⚪' && FORCE_F_CRITERIA.includes(s.criterionId)) {
      reasons.push(s.criterionId);
    }
  }
  if (reasons.length === 0) return { health, forcedF: false, forcedFReasons: [] };
  // Clamp into the F band (any value < 0.40 grades F). Keep the smaller of the
  // two so a genuinely-lower health isn't inflated.
  const capped = Math.min(health, 0.39);
  return { health: capped, forcedF: true, forcedFReasons: reasons };
}

export type GradeBand = 'A' | 'B' | 'C' | 'D' | 'F';

/** Grade bands (rubric §9): A≥0.85, B≥0.70, C≥0.55, D≥0.40, else F. */
export function gradeBand(health: number): GradeBand {
  if (health >= 0.85) return 'A';
  if (health >= 0.7) return 'B';
  if (health >= 0.55) return 'C';
  if (health >= 0.4) return 'D';
  return 'F';
}
