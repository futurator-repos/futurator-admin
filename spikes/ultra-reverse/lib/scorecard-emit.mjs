// scorecard-emit.mjs — map slice scores → ScorecardSlice[] (functions/shared/scorecard/types.ts).
// The persistence step of the §9.1 loop. For the slice we emit the rows as JSON (DDB/S3 wiring is
// M5, locked to DynamoDB+S3). Shape + verdict mapping mirror the daemon's assessor backbone so these
// rows drop straight into the existing scorecard rollup.

/** daemon `verdictForScore` (scorecard-assess-job-runner.mjs): null→⚪, ≥4→🟢, ≥2→🟡, else 🔴. */
export function verdictForScore(score) {
  if (score == null) return '⚪';
  if (score >= 4) return '🟢';
  if (score >= 2) return '🟡';
  return '🔴';
}

/** 0–1 metric → rubric 0–4 (round). */
const toScore = (x) => (x == null ? null : Math.max(0, Math.min(4, Math.round(x * 4))));

/**
 * @param {object} args
 * @param {{score:number, perMetric:Record<string,number>}} args.structural   structural-diff result
 * @param {{uplift:number, sub:Record<string,number>}} [args.guardrail]         guardrail-uplift result (Case-2 only)
 * @param {string} args.runId
 * @returns {Array<object>}  ScorecardSlice[] (scorecard/types.ts)
 */
export function emitSlices({ structural, guardrail, runId }) {
  const slices = [];
  const slice = (criterionId, value, score, ref, engine, note) => ({
    criterionId,
    stage: 'development', // plan-comparison is a development-stage artifact (StageId)
    score,
    verdict: verdictForScore(score),
    value,
    evidence: { kind: 'report', ref },
    note,
    ieIds: [],
    fixIds: [],
    engine,
  });

  // structural diff — one slice per metric + the aggregate (engine: deterministic)
  for (const [m, v] of Object.entries(structural.perMetric)) {
    slices.push(slice(`STRUCT-${m}`, round3(v), toScore(v), `structural.perMetric.${m}`, 'deterministic'));
  }
  slices.push(slice('STRUCT-aggregate', round3(structural.score), toScore(structural.score), 'structural.score', 'deterministic',
    `runId=${runId}`));

  // guardrail uplift — Case-2 uplift, reported on its OWN axis (never a Case-1 loss)
  if (guardrail) {
    for (const [k, v] of Object.entries(guardrail.sub)) {
      slices.push(slice(`GUARD-${k}`, round3(v), toScore(v), `guardrail.sub.${k}`, 'deterministic'));
    }
    slices.push(slice('GUARD-uplift', round3(guardrail.uplift), toScore(guardrail.uplift), 'guardrail.uplift', 'deterministic',
      'Case-2 uplift axis (Case 1 has no guardrails by design)'));
  }
  return slices;
}

const round3 = (x) => (typeof x === 'number' ? Math.round(x * 1000) / 1000 : x);
