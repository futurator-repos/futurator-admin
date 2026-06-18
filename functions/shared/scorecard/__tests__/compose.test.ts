// Tests for compose.ts — Plan Retrospect composer (spec §4c).
//
// Asserts the two load-bearing composer behaviors:
//   1. Hard caps surface — OV11-at-0 forces grade F and reports the
//      whole-pipeline cap reason (spec §6e); the [MECH]-at-0 stage cap flows
//      through pipelineHealth.
//   2. Improvement-action generation — the three §4c map cases:
//        (a) IE → F-finding(s), rendered with reconciled shipped/open state
//            (IE17 → F14 open · F15 open · F17 shipped 0d5dd6a);
//        (b) IE → a Story, NOT an F (IE28/SK5 → Story 4.2, dependsOn F26) —
//            no phantom draft F;
//        (c) no IE / no mapping → a drafted candidate F.
//   Plus: detector-attached fixes (D-KC4 → F16) are honored, 🟢/⚪ slices emit
//   no action, and topRegressions/topWins diff vs the v0 pacman3 baseline.

import { describe, it, expect } from 'vitest';
import { composeRealityCheck } from '../compose';
import type { ScorecardSlice, Verdict, DetectorContext, FixRef } from '../types';
import { CRITERIA_META } from '../criteria-meta';

// ── helpers ────────────────────────────────────────────────────────────────

function slice(
  criterionId: string,
  score: ScorecardSlice['score'],
  verdict: Verdict,
  opts: { ieIds?: string[]; fixIds?: FixRef[]; value?: number | string } = {},
): ScorecardSlice {
  return {
    criterionId,
    stage: CRITERIA_META[criterionId].stage,
    score,
    verdict,
    value: opts.value ?? 0,
    evidence: { kind: 'forensic', ref: `${criterionId}#test` },
    ieIds: opts.ieIds ?? CRITERIA_META[criterionId].ieLink,
    fixIds: opts.fixIds ?? [],
    engine: 'deterministic',
  };
}

// Minimal DetectorContext — the composer reads only `ctx.planId` (+ passes ctx
// through to detectInefficiencies, which reads only the slices in Phase 1).
const CTX = { planId: 'plan_test_abc' } as unknown as DetectorContext;

// ── hard caps ────────────────────────────────────────────────────────────────

describe('composeRealityCheck — hard caps', () => {
  it('OV11-at-0 forces grade F and names the whole-pipeline cap reason (§6e)', () => {
    const rc = composeRealityCheck(
      [slice('D-CC1', 4, '🟢'), slice('OV1', 4, '🟢'), slice('OV11', 0, '🔴', { ieIds: ['IE23'] })],
      CTX,
    );
    expect(rc.forcedF).toBe(true);
    expect(rc.forcedFReasons).toContain('OV11');
    expect(rc.gradeBand).toBe('F');
    expect(rc.pipelineHealth).toBeLessThan(0.4);
  });

  it('[MECH]-at-0 caps its stage at 0.5 (flows through pipelineHealth)', () => {
    // D-CC1 is [MECH]; at 0 it caps the whole development stage to 0.5 even
    // though a sibling scored 4.
    const rc = composeRealityCheck(
      [slice('D-CC1', 0, '🔴', { ieIds: ['IE1'] }), slice('D-MG1', 4, '🟢')],
      CTX,
    );
    expect(rc.stageScores.development).toBeLessThanOrEqual(0.5);
  });

  it('no forced-F cap when no DP-S1/P-S1/OV11 scores 0', () => {
    const rc = composeRealityCheck([slice('OV11', 4, '🟢'), slice('D-CC1', 2, '🟡')], CTX);
    expect(rc.forcedF).toBe(false);
    expect(rc.forcedFReasons).toEqual([]);
  });
});

// ── improvement actions (the three §4c map cases) ─────────────────────────────

describe('composeRealityCheck — improvement actions', () => {
  it('case (a): IE → F-finding(s) with per-finding reconciled state (IE17 → F14/F15/F17)', () => {
    const rc = composeRealityCheck([slice('D-KC3', 0, '🔴', { ieIds: ['IE17'] })], CTX);
    const action = rc.actions.find((a) => a.redCriterion === 'D-KC3');
    expect(action).toBeDefined();
    const ids = action!.fixIds.map((f) => f.id);
    expect(ids).toEqual(expect.arrayContaining(['F14', 'F15', 'F17']));
    // Per-finding state preserved (not collapsed): F17 shipped with its SHA.
    const f17 = action!.fixIds.find((f) => f.id === 'F17');
    expect(f17?.status).toBe('shipped');
    expect(f17?.sha).toBe('0d5dd6a');
    const f14 = action!.fixIds.find((f) => f.id === 'F14');
    expect(f14?.status).toBe('open');
    expect(action!.draftFinding).toBeUndefined();
  });

  it('case (b): IE28/SK5 → Story 4.2 (dependsOn F26), NOT a phantom draft F', () => {
    const rc = composeRealityCheck([slice('SK5', 0, '🔴', { ieIds: ['IE28'] })], CTX);
    const action = rc.actions.find((a) => a.redCriterion === 'SK5');
    expect(action).toBeDefined();
    const story = action!.fixIds.find((f) => f.id === '4.2');
    expect(story?.kind).toBe('story');
    expect(story?.dependsOn).toContain('F26');
    // The story IS the mapping → no drafted candidate F.
    expect(action!.draftFinding).toBeUndefined();
  });

  it('case (c): a fired slice with no mapped fix drafts a candidate F', () => {
    // D-PW1 has no ieLink/fixLink in CRITERIA_META → no mapping.
    const rc = composeRealityCheck([slice('D-PW1', 0, '🔴', { ieIds: [] })], CTX);
    const action = rc.actions.find((a) => a.redCriterion === 'D-PW1');
    expect(action).toBeDefined();
    expect(action!.fixIds).toEqual([]);
    expect(action!.draftFinding).toMatch(/candidate/i);
    expect(action!.draftFinding).toContain('D-PW1');
  });

  it('honors detector-attached fixes (D-KC4 → F16) when no IE row maps', () => {
    // D-KC4's orphan-SURFACING fix is F16, attached by the detector (it has no
    // IE row of its own in the reduction bundle). The composer must link it,
    // not draft a phantom F.
    const f16: FixRef = { id: 'F16', kind: 'F', status: 'open' };
    const rc = composeRealityCheck([slice('D-KC4', 1, '🟡', { ieIds: [], fixIds: [f16] })], CTX);
    const action = rc.actions.find((a) => a.redCriterion === 'D-KC4');
    expect(action!.fixIds.map((f) => f.id)).toContain('F16');
    expect(action!.draftFinding).toBeUndefined();
  });

  it('🟢 and ⚪ slices generate no action', () => {
    const rc = composeRealityCheck([slice('D-MG1', 4, '🟢'), slice('D-VQ2', null, '⚪')], CTX);
    expect(rc.actions).toEqual([]);
  });

  it('orders actions worst-criterion-first (🔴 before 🟡)', () => {
    const rc = composeRealityCheck(
      [slice('D-TA2', 2, '🟡', { ieIds: ['IE7'] }), slice('D-CC1', 0, '🔴', { ieIds: ['IE1'] })],
      CTX,
    );
    expect(rc.actions[0].redCriterion).toBe('D-CC1');
    expect(rc.actions[1].redCriterion).toBe('D-TA2');
  });
});

// ── inefficiencies + baseline diff ────────────────────────────────────────────

describe('composeRealityCheck — inefficiencies & baseline', () => {
  it('rolls fired slices into the top-level inefficiency list with reconciled fixes', () => {
    const rc = composeRealityCheck([slice('D-CC1', 0, '🔴', { ieIds: ['IE1'], value: 71 })], CTX);
    const ie1 = rc.inefficiencies.find((i) => i.id === 'IE1');
    expect(ie1).toBeDefined();
    expect(ie1!.verdict).toBe('🔴');
    expect(ie1!.value).toBe(71);
    expect(ie1!.fixIds.map((f) => f.id)).toContain('F1');
  });

  it('topWins lists a criterion that beat its v0 pacman3 baseline', () => {
    // Baseline D-CC1 = 0 (🔴). A run scoring it 4 (🟢) is a win.
    const rc = composeRealityCheck([slice('D-CC1', 4, '🟢')], CTX);
    expect(rc.topWins.some((w) => w.startsWith('D-CC1'))).toBe(true);
    expect(rc.topRegressions).toEqual([]);
  });

  it('topRegressions lists a criterion that fell below its baseline', () => {
    // Baseline D-MG1 = 4 (🟢). A run scoring it 0 is a regression.
    const rc = composeRealityCheck([slice('D-MG1', 0, '🔴')], CTX);
    expect(rc.topRegressions.some((r) => r.startsWith('D-MG1'))).toBe(true);
  });

  it('stubs the trend + flags v0/pacman3 calibration (Phase 1–2, no cohort diffing)', () => {
    const rc = composeRealityCheck([slice('D-CC1', 2, '🟡')], CTX);
    expect(rc.trend).toBe('phase-3-stub');
    expect(rc.thresholdCalibration).toBe('v0/pacman3-unvalidated');
  });
});
