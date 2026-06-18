// Plan Retrospect — inefficiency catalog (rubric §8 / spec §4d)
//
// `detectInefficiencies(slices, ctx)` rolls the per-criterion detector slices
// up into the top-level `inefficiencies[]` list the rubric §0.5 schema emits —
// one entry per detected IE id (rubric §8 IE1..IE29), each carrying the
// triggering criterion's `{verdict, value, evidence}` and the reconciled
// `FixRef[]` from `ie-to-f-map.ts`.
//
// "Detected" = an IE id appears in at least one slice's `ieIds` AND that slice
// actually fired (verdict is 🔴 or 🟡 — a 🟢 criterion did NOT reproduce its
// linked inefficiency, and a ⚪ criterion couldn't be measured, so neither
// surfaces an IE). This is the honest reading: the IE list is the set of
// inefficiencies the run REPRODUCED, not the set the rubric knows about.
//
// When one IE is linked from several criteria (e.g. IE1 ← D-CC1/D-CC2/D-CC3,
// IE15 ← D-TA4/Q-C7), we surface ONE entry and attach the worst-verdict
// triggering slice's evidence (🔴 over 🟡), so the operator sees the strongest
// witness. The full per-criterion detail stays in the slices.

import type { ScorecardSlice, DetectorContext, Verdict, EvidenceRef, FixRef } from './types';
import { mapIeToFixes } from './ie-to-f-map';

/**
 * One top-level inefficiency entry (rubric §0.5 `inefficiencies[]` shape +
 * the Plan-Retrospect FixRef extension).
 */
export interface IEResult {
  /** §8 IE id, e.g. "IE1", "IE25". */
  id: string;
  /** Worst verdict across the criteria that reproduced this IE (🔴 > 🟡). */
  verdict: Verdict;
  /** The triggering criterion's `value` (number for ratios/counts, string when labelled). */
  value: number | string;
  /** Evidence ref from the worst-verdict triggering slice (NOT a dump, §5). */
  evidence: EvidenceRef;
  /** The criterion ids that reproduced this IE (stable order = slice order). */
  criterionIds: string[];
  /** Reconciled fix(es) addressing this IE, each with shipped/open state. */
  fixIds: FixRef[];
}

/** Verdict severity for "pick the worst witness". Higher = worse. */
const SEVERITY: Record<Verdict, number> = {
  '🔴': 3,
  '🟡': 2,
  '🟢': 1,
  '⚪': 0,
};

/** Only 🔴/🟡 slices reproduce an inefficiency (🟢 cleared it; ⚪ couldn't measure). */
function fired(s: ScorecardSlice): boolean {
  return s.verdict === '🔴' || s.verdict === '🟡';
}

/**
 * Build the top-level `inefficiencies[]` from the detector slices.
 *
 * `ctx` is accepted for symmetry with the other composer-side helpers and to
 * leave room for context-derived IEs (e.g. ones a future detector keys off
 * `ctx` rather than a slice); Phase 1 derives the list purely from slice
 * `ieIds`, so it is currently unused by the body.
 *
 * Returns entries sorted by id ascending numerically (IE1, IE2, … IE29) so the
 * Reality Check renders a stable, scannable list.
 */
export function detectInefficiencies(
  slices: ScorecardSlice[],
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  _ctx: DetectorContext,
): IEResult[] {
  // ieId → the accumulating entry (worst-witness wins for verdict/value/evidence).
  const byIe = new Map<string, IEResult>();

  for (const slice of slices) {
    if (!fired(slice)) continue;
    for (const ieId of slice.ieIds) {
      const existing = byIe.get(ieId);
      if (!existing) {
        byIe.set(ieId, {
          id: ieId,
          verdict: slice.verdict,
          value: slice.value,
          evidence: slice.evidence,
          criterionIds: [slice.criterionId],
          // Single source of truth for fix linkage + reconciled state.
          fixIds: mapIeToFixes(ieId),
        });
        continue;
      }
      // Already seen this IE from another criterion. Track the criterion, and
      // promote the witness if this slice is more severe (🔴 over 🟡).
      if (!existing.criterionIds.includes(slice.criterionId)) {
        existing.criterionIds.push(slice.criterionId);
      }
      if (SEVERITY[slice.verdict] > SEVERITY[existing.verdict]) {
        existing.verdict = slice.verdict;
        existing.value = slice.value;
        existing.evidence = slice.evidence;
      }
    }
  }

  return Array.from(byIe.values()).sort((a, b) => ieNum(a.id) - ieNum(b.id));
}

/** Numeric suffix of an IE id for stable ordering ("IE12" → 12). NaN ids sort last. */
function ieNum(id: string): number {
  const n = Number(id.replace(/^IE/, ''));
  return Number.isFinite(n) ? n : Number.MAX_SAFE_INTEGER;
}
