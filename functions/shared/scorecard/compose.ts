// Plan Retrospect — composer (spec §4c)
//
// `composeRealityCheck(slices, ctx)` is the pure, deterministic roll-up that
// turns graded `ScorecardSlice[]` into the operator-facing **Reality Check**:
//
//   1. Roll up via `rollup.ts` — per-stage scores (post-[MECH]-at-0 cap),
//      pipeline health, the forced-F hard caps (DP-S1 / P-S1 / OV11 — OV11 is
//      the whole-pipeline cap, spec §6e), and the grade band.
//   2. Build the top-level inefficiency list (`ie-catalog.ts`).
//   3. `topRegressions` / `topWins` — vs the v0 pacman3 baseline ONLY
//      (Phase 1–2, spec §3 reviewer fix #12). NO cohort/version diffing; the
//      ▲/▼ trend + sparkline are STUBBED until pipeline-versioning lands
//      (Phase 3) — `trend: 'phase-3-stub'` says so on the wire.
//   4. `actions` — one `ImprovementAction` per 🔴/🟡 slice (spec §4c), via the
//      three map cases:
//        (a) IE → one-or-more F-findings → link them (per-finding shipped/open).
//        (b) IE → a Story (IE28 → Story 4.2, dependsOn F26) → link the story;
//            do NOT draft a phantom new F.
//        (c) no IE / no mapping → draft a candidate `F<n>` for operator ratify.
//
// Pure + deterministic: same slices in → same Reality Check out. No I/O, no LLM.

import type { ScorecardSlice, DetectorContext, ImprovementAction, FixRef, StageId } from './types';
import { pipelineHealth, gradeBand, type GradeBand, type PipelineHealthResult } from './rollup';
import { detectInefficiencies, type IEResult } from './ie-catalog';
import { mapIeToFixes } from './ie-to-f-map';

// ── v0 pacman3 baseline (spec §3 reviewer fix #12) ────────────────────────────
//
// The SINGLE stored reference scorecard the Phase-1–2 `topRegressions`/`topWins`
// compare against. Kept as data here (not a DDB read) so the composer stays
// pure. Values are the v0/pacman3 single-run calibration — UNVALIDATED across
// runs; every consumer must render the `[thresholds: v0/pacman3, unvalidated]`
// caveat. This is NOT cohort diffing (which requires pipeline-versioning,
// Phase 3) — it is a one-baseline delta, and the trend arrows are stubbed.
//
// Only criteria with a meaningful baseline verdict are listed; a criterion
// absent here has no baseline to diff against and is omitted from regressions/
// wins (it can't have moved relative to nothing).
interface BaselineEntry {
  score: 0 | 1 | 2 | 3 | 4;
  verdict: '🟢' | '🟡' | '🔴';
}

/**
 * The v0 pacman3 reference verdicts. Sourced from the pacman3 analysis the
 * rubric was calibrated on (spec §3 example + rubric §0.6 IE links). These are
 * the run's known 🔴/🟡/🟢 outcomes — the baseline a later run is measured
 * "better/worse than".
 */
export const V0_PACMAN3_BASELINE: Record<string, BaselineEntry> = {
  // Development — the pacman3 reds (spec §3 example)
  'D-CC1': { score: 0, verdict: '🔴' }, // compile thrash 87/story
  'D-CC2': { score: 0, verdict: '🔴' },
  'D-CC3': { score: 1, verdict: '🟡' },
  'D-VQ1': { score: 0, verdict: '🔴' }, // VQA unverifiable 38%
  'D-VQ3': { score: 0, verdict: '🔴' },
  'D-TA2': { score: 2, verdict: '🟡' }, // author/dev ratio 0.82
  'D-WS1': { score: 0, verdict: '🔴' }, // parallelism 1.04×
  'D-KC3': { score: 0, verdict: '🔴' }, // orphans accumulation
  'D-MG1': { score: 4, verdict: '🟢' }, // clean merges
  // Skills — the subsystem reds (spec §6a)
  SK2: { score: 0, verdict: '🔴' }, // activation collapse 5.2%
  SK3: { score: 0, verdict: '🔴' }, // loadout unranked / retrieval dark
  SK4: { score: 0, verdict: '🔴' }, // scout dormancy 0 runs
  // Overview — cost / loop reds
  OV2: { score: 2, verdict: '🟡' }, // cost vs ceiling
  OV4: { score: 0, verdict: '🔴' }, // cost reconciliation gap (F2/F3)
  OV6: { score: 0, verdict: '🔴' }, // count drift done>total
  OV8: { score: 0, verdict: '🔴' }, // reflector write-loss
  OV11: { score: 4, verdict: '🟢' }, // MCP-config precondition held on pacman3
  // QA
  'Q-C9': { score: 0, verdict: '🔴' }, // stage-isolation breach
};

// ── Reality Check wire shape ──────────────────────────────────────────────────

/** Verdict severity for ranking regressions/wins. Higher = worse. */
const SEVERITY = { '🔴': 3, '🟡': 2, '🟢': 1, '⚪': 0 } as const;

/**
 * The composed Reality Check (spec §3 "so-what" + §4c). The repository persists
 * a §0.5-shaped projection of this (one row per stage, §5); the UI renders it
 * directly. Pure function of the slices.
 */
export interface RealityCheck {
  planId: string;
  /** Per-stage normalized score (post-[MECH]-cap), null where unscored. */
  stageScores: Record<StageId, number | null>;
  /** 0–1 pipeline health (post hard caps). */
  pipelineHealth: number;
  gradeBand: GradeBand;
  /** True when a forced-F cap fired (DP-S1 / P-S1 / OV11). */
  forcedF: boolean;
  /** Criterion ids that forced F (e.g. ['OV11'] — the whole-pipeline cap). */
  forcedFReasons: string[];
  /** Top-level inefficiencies this run reproduced (rubric §0.5 `inefficiencies[]`). */
  inefficiencies: IEResult[];
  /** Criteria worse than the v0 pacman3 baseline (human strings, worst-first). */
  topRegressions: string[];
  /** Criteria better than the v0 pacman3 baseline (human strings, best-first). */
  topWins: string[];
  /** One generated action per 🔴/🟡 slice (spec §4c). */
  actions: ImprovementAction[];
  /**
   * Trend marker. Phase 1–2 is single-baseline only; run-over-run trend +
   * sparkline land in Phase 3 with pipeline-versioning (spec §3). Always
   * 'phase-3-stub' here so the UI renders "[trend: Phase 3]" rather than lying.
   */
  trend: 'phase-3-stub';
  /** Provenance caveat — every quantitative threshold is v0/pacman3, unvalidated. */
  thresholdCalibration: 'v0/pacman3-unvalidated';
}

// ── helpers ───────────────────────────────────────────────────────────────────

/** True for a slice that fired a defect (🔴/🟡) — the action/regression trigger. */
function fired(s: ScorecardSlice): boolean {
  return s.verdict === '🔴' || s.verdict === '🟡';
}

/**
 * topRegressions / topWins vs the v0 pacman3 baseline (Phase 1–2 only). A
 * "regression" is a criterion that scored WORSE than its baseline; a "win"
 * scored BETTER. Criteria with no baseline entry are skipped (nothing to diff).
 */
function diffVsBaseline(slices: ScorecardSlice[]): { regressions: string[]; wins: string[] } {
  const regressions: Array<{ label: string; delta: number }> = [];
  const wins: Array<{ label: string; delta: number }> = [];

  for (const s of slices) {
    if (s.score === null || s.verdict === '⚪') continue; // unmeasured → no diff
    const base = V0_PACMAN3_BASELINE[s.criterionId];
    if (!base) continue;
    const delta = s.score - base.score;
    if (delta < 0) {
      regressions.push({
        label: `${s.criterionId} ${s.verdict} (${s.value}) — was ${base.verdict} (score ${base.score} → ${s.score})`,
        delta,
      });
    } else if (delta > 0) {
      wins.push({
        label: `${s.criterionId} ${s.verdict} (${s.value}) — was ${base.verdict} (score ${base.score} → ${s.score})`,
        delta,
      });
    }
  }

  // Worst regressions first (most-negative delta); biggest wins first.
  regressions.sort((a, b) => a.delta - b.delta);
  wins.sort((a, b) => b.delta - a.delta);
  return { regressions: regressions.map((r) => r.label), wins: wins.map((w) => w.label) };
}

/**
 * Generate one `ImprovementAction` per fired (🔴/🟡) slice (spec §4c). Three
 * map cases:
 *   (a) the slice carries IE ids that map to F-findings (or a Story) →
 *       collect every mapped fix WITH its reconciled state. (IE28 → Story 4.2
 *       is a Story FixRef, handled transparently by `mapIeToFixes`, so we never
 *       draft a phantom F for it — case b.)
 *   (b) handled inside (a): a Story-kind FixRef is a real mapping, not "no map".
 *   (c) no IE OR no IE maps to anything → draft a candidate `F<n>` the operator
 *       ratifies. The slice's own `fixIds` (a detector may have pre-attached
 *       reconciled fixes, e.g. D-KC4 → F16 via ORPHAN_SURFACING_FIX) are used
 *       as the mapping when present, so detector-attached fixes are honored.
 */
function generateActions(slices: ScorecardSlice[]): ImprovementAction[] {
  const actions: ImprovementAction[] = [];
  let draftCounter = 0;

  for (const s of slices) {
    if (!fired(s)) continue;

    // Collect the reconciled fixes. Prefer the IE→fix map (single source of
    // truth); also fold in any fixes the detector pre-attached on the slice
    // (e.g. D-KC4's ORPHAN_SURFACING_FIX / F16, which has no IE row of its own).
    const fixIds = collectFixes(s);

    if (fixIds.length > 0) {
      // Cases (a)/(b): real mapping (F-finding(s) and/or a Story). Link as-is.
      actions.push({
        redCriterion: s.criterionId,
        ieIds: [...s.ieIds],
        fixIds,
        status: 'open',
      });
    } else {
      // Case (c): no mapping → draft a candidate F for operator ratify.
      draftCounter += 1;
      actions.push({
        redCriterion: s.criterionId,
        ieIds: [...s.ieIds],
        fixIds: [],
        status: 'open',
        draftFinding: `F-draft-${draftCounter} (candidate): no mapped fix for ${s.criterionId}${
          s.ieIds.length ? ` / ${s.ieIds.join(',')}` : ''
        } — ratify into pipeline-v2.5-fixes-plan.md`,
      });
    }
  }

  return actions;
}

/**
 * The reconciled fix set for a slice: the union of (1) every fix its IE ids map
 * to via `ie-to-f-map.ts`, and (2) any fixes the detector pre-attached on the
 * slice (`slice.fixIds`). De-duplicated by `id`, preserving the first-seen
 * (map-authoritative) `FixRef` so shipped/open + sha state is the canonical one.
 */
function collectFixes(s: ScorecardSlice): FixRef[] {
  const out: FixRef[] = [];
  const seen = new Set<string>();
  const add = (f: FixRef) => {
    if (seen.has(f.id)) return;
    seen.add(f.id);
    out.push({ ...f });
  };
  for (const ieId of s.ieIds) {
    for (const f of mapIeToFixes(ieId)) add(f);
  }
  for (const f of s.fixIds) add(f);
  return out;
}

// ── entrypoint ────────────────────────────────────────────────────────────────

/**
 * Compose the Reality Check from graded slices (spec §4c). Pure + deterministic.
 *
 * The OV11 whole-pipeline hard cap (spec §6e) is applied inside
 * `pipelineHealth` → `applyHardCaps` (it lists OV11 in `FORCE_F_CRITERIA`), so
 * `forcedF`/`forcedFReasons` already reflect it; we surface them here.
 */
export function composeRealityCheck(slices: ScorecardSlice[], ctx: DetectorContext): RealityCheck {
  const health: PipelineHealthResult = pipelineHealth(slices);
  const grade = gradeBand(health.health);
  const inefficiencies = detectInefficiencies(slices, ctx);
  const { regressions, wins } = diffVsBaseline(slices);
  const actions = generateActions(slices);

  // Order the action list worst-criterion-first for the operator (🔴 before 🟡),
  // matching the regression ordering. Stable within a verdict.
  const verdictOf = new Map(slices.map((s) => [s.criterionId, s.verdict]));
  actions.sort(
    (a, b) =>
      (SEVERITY[verdictOf.get(b.redCriterion) ?? '⚪'] ?? 0) -
      (SEVERITY[verdictOf.get(a.redCriterion) ?? '⚪'] ?? 0),
  );

  return {
    planId: ctx.planId,
    stageScores: health.stageScores,
    pipelineHealth: health.health,
    gradeBand: grade,
    forcedF: health.forcedF,
    forcedFReasons: health.forcedFReasons,
    inefficiencies,
    topRegressions: regressions,
    topWins: wins,
    actions,
    trend: 'phase-3-stub',
    thresholdCalibration: 'v0/pacman3-unvalidated',
  };
}
