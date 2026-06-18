// Plan Retrospect — the reconciled IE → Fix map (rubric §8 / spec §6d)
//
// THE SINGLE SOURCE OF TRUTH for which fix(es) address each inefficiency, and
// each fix's reconciled shipped/open state. The composer (spec §4c) renders
// every mapped finding with its OWN state — never collapsed to one F, never
// invents or omits a mapped finding.
//
// Status reconciliation (rubric §12 de-bias #3 — "self-credit down-weight"):
//   - SHIPPED only where a real commit SHA exists in pipeline-v2.5-fixes-plan.md:
//       F17 → 0d5dd6a   (projectId partition drift)
//       F18 → 0445e6a   (living-doc REFERENCES edges)
//       F19, F20, F21 → 1755365  (deploy URL / framework-detect / observability)
//       F3  → shipped in functions/shared/timer/forensic-builder.ts (no isolated SHA)
//   - Everything else is `open` (proposed), regardless of annotation phrasing.
//
// Three map cases (spec §4c):
//   (a) IE → one-or-more F-findings (most rows).
//   (b) IE → a Story, not an F: IE28 → Story 4.2, with F26 as an enabling dep
//       ({kind:'story', ref:'4.2', dependsOn:['F26']}) so the composer does NOT
//       draft a phantom new F for IE28.
//   (c) IE → no mapping → composer drafts a new candidate F (handled there).
//
// Reconciled chains (rubric §8 + §12, spec §6b/§6d):
//   IE16→F14 · IE17→F14+F15+F17(shipped) · IE18→F17(shipped) · IE19→F15
//   orphan-surfacing→F16 (D-KC4 only; NOT in IE17's reduction bundle)
//   IE28→Story 4.2 (+F26 bridge), NOT an F
//   deployment "F14/F15" forward-refs are canonical F22/F23; OV11 `Fnew` = F23.

import type { FixRef } from './types';

/** SHAs for the fixes shipped this session (single source for the `sha` field). */
const SHA = {
  F17: '0d5dd6a',
  F18: '0445e6a',
  // F19/F20/F21 all shipped together.
  DEPLOY: '1755365',
  // F12 (QA evidence honesty) shipped 2026-06-18 in the QA-fix commit. F11
  // (deploy×QA stage isolation) is NOT in it — stays open (FIX4's primary-feature
  // surface mitigates the symptom, not the race).
  QA_FIX: '3444320',
} as const;

/**
 * Note appended to session fixes that were implemented but not yet committed
 * with an isolated SHA (the composer surfaces this so the operator isn't told
 * to "ship" something whose state is ambiguous).
 */
export const SESSION_IMPLEMENTED_NOT_COMMITTED =
  'implemented this session; not yet committed under an isolated SHA — verify before re-shipping';

const F = (id: string, status: FixRef['status'], sha?: string, dependsOn?: string[]): FixRef => ({
  id,
  kind: 'F',
  status,
  ...(sha ? { sha } : {}),
  ...(dependsOn ? { dependsOn } : {}),
});

const story = (ref: string, dependsOn?: string[]): FixRef => ({
  id: ref,
  kind: 'story',
  status: 'open',
  ...(dependsOn ? { dependsOn } : {}),
});

/**
 * IE id → the fix(es) that address it, each with its reconciled state.
 *
 * Conservative default: `open` unless a commit SHA exists. F2/F4/F5/F6/F7/F8/
 * F9/F10/F11/F12/F13/F14/F15/F16/F22/F23/F24/F25/F26/F27/F28 are all `open`
 * (proposed) per the fixes-plan registry / track table.
 */
export const IE_TO_FIX: Record<string, FixRef[]> = {
  // ── Correctness / observability (Track A/B) ──
  IE1: [F('F1', 'open')], // compile thrash
  IE2: [F('F2', 'open')], // retry log orphaning (priorJobIds not yet written)
  IE3: [F('F3', 'shipped')], // forensic cost gap — shipped in forensic-builder.ts
  IE4: [F('F4', 'open')], // count drift (done>total)
  IE5: [F('F5', 'open')], // reflector write-loss (IAM-blocked)
  IE6: [F('F6', 'open')], // cost-ceiling overrun
  IE7: [F('F7', 'open')], // test-author cost inversion
  IE8: [F('F8', 'open')], // wasted fix rounds
  IE9: [F('F8', 'open')], // VQA unverifiable rate (same fix as IE8)
  IE10: [F('F9', 'open')], // skills catalog overhead (secondary; primary IE25/IE27)
  IE11: [F('F10', 'open')], // low parallelism
  // IE12 → §5 of the fixes plan (no canonical F id) → composer drafts a candidate.
  IE13: [F('F11', 'open')], // stage-isolation breach (deploy×QA race)

  // ── QA evidence integrity (Track F) ──
  IE14: [F('F12', 'shipped', SHA.QA_FIX)], // QA evidence-capture failure — SHIPPED
  IE15: [F('F12', 'shipped', SHA.QA_FIX)], // infra failure scored as defect — SHIPPED

  // ── Knowledge-graph integrity (Track G) — reconciled chains ──
  IE16: [F('F14', 'open')], // AST-facts truncation
  IE17: [F('F14', 'open'), F('F15', 'open'), F('F17', 'shipped', SHA.F17)], // orphan accumulation (reduction bundle — F16 deliberately excluded)
  IE18: [F('F17', 'shipped', SHA.F17)], // projectId partition drift — SHIPPED
  IE19: [F('F15', 'open')], // knowledge-graph zombies

  // ── Deployment (Track H) — canonical IDs (NOT the "F14/F15" forward-refs) ──
  IE20: [F('F19', 'shipped', SHA.DEPLOY)], // published-URL truncation — SHIPPED
  IE21: [F('F20', 'shipped', SHA.DEPLOY)], // deploy config improvisation — SHIPPED
  IE22: [F('F22', 'open')], // rebuild-on-promote (build-once violated; subdomains proposed)
  IE23: [F('F23', 'open')], // agent-spawn precondition missing (= OV11)
  IE24: [F('F21', 'shipped', SHA.DEPLOY)], // non-prod deploy unobservable — SHIPPED

  // ── Skills (Track I) ──
  IE25: [F('F24', 'open')], // skill activation collapse
  IE26: [F('F25', 'open')], // scout dormancy
  IE27: [F('F27', 'open')], // loadout unranked / retrieval dark
  IE28: [story('4.2', ['F26'])], // unvetted skill reaches app → Story 4.2 (+F26 bridge), NOT an F
  IE29: [F('F28', 'open')], // dead-skill accumulation
};

/**
 * D-KC4 (orphan-invariant SURFACING) maps to F16 — deliberately NOT in IE17's
 * reduction bundle (rubric §12 de-bias #2: F16 is the surfacer, not a reducer;
 * counting it in IE17 would double-count). The composer reads this for the
 * D-KC4 criterion directly (it has no IE row of its own in the reduction map).
 */
export const ORPHAN_SURFACING_FIX: FixRef[] = [F('F16', 'open')];

/**
 * Resolve the fix(es) for an IE id. Returns a fresh array (so callers can't
 * mutate the canonical map). Unknown ids → [] (case c: composer drafts a new F).
 */
export function mapIeToFixes(ieId: string): FixRef[] {
  const fixes = IE_TO_FIX[ieId];
  return fixes ? fixes.map((f) => ({ ...f })) : [];
}
