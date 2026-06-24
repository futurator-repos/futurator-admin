/**
 * Map slice scores → ScorecardSlice[] (TS port of spikes/ultra-reverse/lib/scorecard-emit.mjs).
 * Shape + verdict mapping mirror the daemon assessor so rows drop into the shared scorecard rollup.
 */

import type { ScorecardSlice, Verdict } from '../scorecard/types';
import type { StructuralDiffResult } from './structural-diff';
import type { GuardrailResult } from './guardrail-uplift';

export function verdictForScore(score: number | null): Verdict {
  if (score == null) return '⚪';
  if (score >= 4) return '🟢';
  if (score >= 2) return '🟡';
  return '🔴';
}

type Score = 0 | 1 | 2 | 3 | 4 | null;
const toScore = (x: number | null): Score =>
  x == null ? null : (Math.max(0, Math.min(4, Math.round(x * 4))) as Score);
const round3 = (x: number) => Math.round(x * 1000) / 1000;

export function emitSlices(args: {
  structural: StructuralDiffResult;
  guardrail?: GuardrailResult;
  runId: string;
}): ScorecardSlice[] {
  const { structural, guardrail, runId } = args;
  const slices: ScorecardSlice[] = [];
  const slice = (
    criterionId: string,
    value: number | string,
    score: Score,
    ref: string,
    note?: string,
  ): ScorecardSlice => ({
    criterionId,
    stage: 'development',
    score,
    verdict: verdictForScore(score),
    value,
    evidence: { kind: 'report', ref },
    note,
    ieIds: [],
    fixIds: [],
    engine: 'deterministic',
  });

  for (const [m, v] of Object.entries(structural.perMetric)) {
    slices.push(slice(`STRUCT-${m}`, round3(v), toScore(v), `structural.perMetric.${m}`));
  }
  slices.push(
    slice(
      'STRUCT-aggregate',
      round3(structural.score),
      toScore(structural.score),
      'structural.score',
      `runId=${runId}`,
    ),
  );

  if (guardrail) {
    for (const [k, v] of Object.entries(guardrail.sub)) {
      slices.push(slice(`GUARD-${k}`, round3(v), toScore(v), `guardrail.sub.${k}`));
    }
    slices.push(
      slice(
        'GUARD-uplift',
        round3(guardrail.uplift),
        toScore(guardrail.uplift),
        'guardrail.uplift',
        'Case-2 uplift axis (Case 1 has no guardrails by design)',
      ),
    );
  }
  return slices;
}
