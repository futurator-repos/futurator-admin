// Tests for rollup.ts — Plan Retrospect aggregation (rubric §0.3/§0.4 + §9).
//
// Asserts:
//   - substageScore weighting + ⚪/null exclusion from the denominator.
//   - [MECH]-at-0 caps its stage at 0.5.
//   - DP-S1/P-S1/OV11-at-0 force grade F (clamped below 0.40).
//   - gradeBand cut points.

import { describe, it, expect } from 'vitest';
import { substageScore, stageScore, pipelineHealth, gradeBand, STAGE_WEIGHTS } from '../rollup';
import type { ScorecardSlice, Verdict } from '../types';
import { CRITERIA_META } from '../criteria-meta';

// ── helpers ────────────────────────────────────────────────────────────────

function slice(
  criterionId: string,
  score: ScorecardSlice['score'],
  verdict: Verdict = score === null ? '⚪' : '🟢',
): ScorecardSlice {
  return {
    criterionId,
    stage: CRITERIA_META[criterionId].stage,
    score,
    verdict,
    value: 0,
    evidence: { kind: 'forensic', ref: 'test' },
    ieIds: [],
    fixIds: [],
    engine: 'deterministic',
  };
}

describe('substageScore', () => {
  it('computes Σ(score×W) / Σ(W×4)', () => {
    // D-CC1 (W3) = 4, D-MG3 (W1) = 2  → (4*3 + 2*1) / ((3+1)*4) = 14/16 = 0.875
    const s = substageScore([slice('D-CC1', 4), slice('D-MG3', 2)]);
    expect(s).toBeCloseTo(0.875, 5);
  });

  it('excludes ⚪/null slices from numerator AND denominator', () => {
    // D-CC1 (W3)=4 scored; D-VQ2 ⚪ excluded → 12 / (3*4) = 1.0
    const s = substageScore([slice('D-CC1', 4), slice('D-VQ2', null)]);
    expect(s).toBe(1);
  });

  it('returns null when nothing is scored', () => {
    expect(substageScore([slice('D-VQ2', null)])).toBeNull();
    expect(substageScore([])).toBeNull();
  });

  it('a perfect 4 across slices is 1.0; all-0 is 0.0', () => {
    expect(substageScore([slice('D-CC1', 4), slice('D-CC2', 4)])).toBe(1);
    expect(substageScore([slice('D-CC1', 0, '🔴'), slice('D-CC2', 0, '🔴')])).toBe(0);
  });
});

describe('stageScore — [MECH]-at-0 cap (rubric §0.4 rule 1)', () => {
  it('caps a stage at 0.5 when a [MECH] criterion scores 0', () => {
    // D-CC1 is [MECH]. Without a cap the mean would be high; the 0 forces ≤0.5.
    // D-CC1(W3)=0, D-MG1(W3)=4 → base = 12/24 = 0.5 already; push others up.
    const slices = [
      slice('D-CC1', 0, '🔴'), // [MECH] = 0 → trips the cap
      slice('D-MG1', 4),
      slice('D-MG2', 4),
      slice('D-MG3', 4),
    ];
    const base = substageScore(slices)!;
    expect(base).toBeGreaterThan(0.5); // would exceed the cap without it
    expect(stageScore(slices)).toBe(0.5);
  });

  it('does NOT cap when the 0 is a non-[MECH] criterion', () => {
    // D-DV1 is [AGENT]-only (not MECH). A 0 there should not trip the cap.
    const slices = [slice('D-DV1', 0, '🔴'), slice('D-MG1', 4), slice('D-MG2', 4)];
    const score = stageScore(slices)!;
    expect(score).toBeGreaterThan(0.5);
  });
});

describe('pipelineHealth — forced-F caps (rubric §0.4 rules 2 & 3)', () => {
  it('DP-S1 == 0 forces grade F', () => {
    const r = pipelineHealth([slice('DP-S1', 0, '🔴'), slice('DP-B1', 4), slice('C-D4', 4)]);
    expect(r.forcedF).toBe(true);
    expect(r.forcedFReasons).toContain('DP-S1');
    expect(gradeBand(r.health)).toBe('F');
  });

  it('OV11 == 0 forces grade F (whole-pipeline cap)', () => {
    const r = pipelineHealth([slice('OV11', 0, '🔴'), slice('OV1', 4), slice('C-D4', 4)]);
    expect(r.forcedF).toBe(true);
    expect(r.forcedFReasons).toContain('OV11');
    expect(gradeBand(r.health)).toBe('F');
  });

  it('P-S1 == 0 forces grade F', () => {
    const r = pipelineHealth([slice('P-S1', 0, '🔴'), slice('P-A1', 4)]);
    expect(gradeBand(r.health)).toBe('F');
  });

  it('no forced-F cap when safety criteria are healthy', () => {
    const r = pipelineHealth([slice('DP-S1', 4), slice('OV11', 4), slice('P-S1', 4)]);
    expect(r.forcedF).toBe(false);
    expect(gradeBand(r.health)).toBe('A');
  });
});

describe('gradeBand cut points (rubric §9)', () => {
  it('maps health to bands at the documented thresholds', () => {
    expect(gradeBand(0.85)).toBe('A');
    expect(gradeBand(0.849)).toBe('B');
    expect(gradeBand(0.7)).toBe('B');
    expect(gradeBand(0.699)).toBe('C');
    expect(gradeBand(0.55)).toBe('C');
    expect(gradeBand(0.549)).toBe('D');
    expect(gradeBand(0.4)).toBe('D');
    expect(gradeBand(0.399)).toBe('F');
    expect(gradeBand(0)).toBe('F');
  });
});

describe('STAGE_WEIGHTS', () => {
  it('sums to 100 (rubric §9)', () => {
    const sum = Object.values(STAGE_WEIGHTS).reduce((a, b) => a + b, 0);
    expect(sum).toBe(100);
  });
});
