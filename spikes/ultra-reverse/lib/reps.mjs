// reps.mjs — N≥5 repetition harness (design §9, strategy M4). Planning is stochastic, so the bench
// compares DISTRIBUTIONS, not single runs. Each rep yields a run record (structural + guardrail);
// this aggregates them to mean±stdev per metric.
//
// For the deterministic projectors a rep is identical (stdev 0) — the value appears once live Case-1
// capture / Case-2 generation introduce variance. The harness is correct now and meaningful then.

import { summarize } from './stats.mjs';

/**
 * Run `n` reps. `runOnce(i) → Promise<{structural:{score,perMetric}, guardrail?:{uplift,sub}, judge?:object}>`.
 * @returns {Promise<{n:number, runs:object[], structural:object, guardrail:object|null, judge:object|null}>}
 */
export async function runReps({ n = 5, runOnce }) {
  const runs = [];
  for (let i = 0; i < n; i++) runs.push(await runOnce(i)); // sequential: reps may share a session/capture seam
  return { n, runs, ...aggregateRuns(runs) };
}

/** Aggregate an array of run records into distributions. Pure — unit-tested directly. */
export function aggregateRuns(runs) {
  const col = (path) => runs.map((r) => dig(r, path)).filter((x) => typeof x === 'number');

  const structuralMetrics = unionKeys(runs.map((r) => r?.structural?.perMetric));
  const structural = {
    score: summarize(col('structural.score')),
    perMetric: Object.fromEntries(structuralMetrics.map((m) => [m, summarize(runs.map((r) => r?.structural?.perMetric?.[m]))])),
  };

  const hasGuardrail = runs.some((r) => r?.guardrail);
  const guardrailSubs = unionKeys(runs.map((r) => r?.guardrail?.sub));
  const guardrail = hasGuardrail
    ? {
        uplift: summarize(col('guardrail.uplift')),
        sub: Object.fromEntries(guardrailSubs.map((k) => [k, summarize(runs.map((r) => r?.guardrail?.sub?.[k]))])),
      }
    : null;

  const hasJudge = runs.some((r) => r?.judge?.perAxis);
  const judgeAxes = unionKeys(runs.map((r) => r?.judge?.perAxis));
  const judge = hasJudge
    ? Object.fromEntries(judgeAxes.map((axis) => [axis, {
        case1: summarize(runs.map((r) => r?.judge?.perAxis?.[axis]?.case1)),
        case2: summarize(runs.map((r) => r?.judge?.perAxis?.[axis]?.case2)),
      }]))
    : null;

  return { structural, guardrail, judge };
}

function dig(obj, path) { return path.split('.').reduce((o, k) => (o == null ? o : o[k]), obj); }
function unionKeys(objs) {
  const s = new Set();
  for (const o of objs) if (o) for (const k of Object.keys(o)) s.add(k);
  return [...s];
}
