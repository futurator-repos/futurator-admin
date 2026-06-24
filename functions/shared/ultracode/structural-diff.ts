/**
 * Scorer 1 — structural diff (TS port of spikes/ultra-reverse/lib/structural-diff.mjs).
 * Compares two DecisionPlans (not prose). Each metric 0–1. The slice uses pattern_match + dag_shape.
 */

import type { DecisionPlan, DecisionPhase } from './decision-plan';

const clamp01 = (x: number) => Math.max(0, Math.min(1, x));
const ratioDelta = (a: number, b: number) => {
  const m = Math.max(Math.abs(a), Math.abs(b));
  return m === 0 ? 1 : clamp01(1 - Math.abs(a - b) / m);
};

export const DEFAULT_WEIGHTS: Record<string, number> = {
  pattern_match: 3,
  phase_count_delta: 1,
  axis_match: 2,
  fanout_width_delta: 1,
  barrier_placement: 2,
  verify_match: 2,
  schema_usage: 1,
  dag_shape: 2,
};

const axisTokens = (axis?: string) =>
  new Set(
    String(axis || '')
      .toLowerCase()
      .split(/[-_\s]+/)
      .filter(Boolean),
  );
function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 1;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  const union = a.size + b.size - inter;
  return union === 0 ? 1 : inter / union;
}
function alignByIndex(
  pa: DecisionPhase[],
  pb: DecisionPhase[],
): Array<[DecisionPhase | null, DecisionPhase | null]> {
  const n = Math.max(pa.length, pb.length);
  const out: Array<[DecisionPhase | null, DecisionPhase | null]> = [];
  for (let i = 0; i < n; i++) out.push([pa[i] ?? null, pb[i] ?? null]);
  return out;
}

export const patternMatch = (a: DecisionPlan, b: DecisionPlan) => (a.pattern === b.pattern ? 1 : 0);
export const phaseCountDelta = (a: DecisionPlan, b: DecisionPlan) =>
  ratioDelta(a.phases.length, b.phases.length);

export function axisMatch(a: DecisionPlan, b: DecisionPlan): number {
  const pairs = alignByIndex(a.phases, b.phases).filter(([x, y]) => x?.fanOut || y?.fanOut);
  if (pairs.length === 0) return 1;
  const scores = pairs.map(([x, y]) =>
    jaccard(axisTokens(x?.fanOut?.axis), axisTokens(y?.fanOut?.axis)),
  );
  return scores.reduce((s, v) => s + v, 0) / scores.length;
}

export function fanoutWidthDelta(a: DecisionPlan, b: DecisionPlan): number {
  const pairs = alignByIndex(a.phases, b.phases).filter(
    ([x, y]) => typeof x?.fanOut?.width === 'number' && typeof y?.fanOut?.width === 'number',
  );
  if (pairs.length === 0) return 1;
  const scores = pairs.map(([x, y]) =>
    ratioDelta(x!.fanOut!.width as number, y!.fanOut!.width as number),
  );
  return scores.reduce((s, v) => s + v, 0) / scores.length;
}

export function barrierPlacement(a: DecisionPlan, b: DecisionPlan): number {
  const pairs = alignByIndex(a.phases, b.phases);
  if (pairs.length === 0) return 1;
  let agree = 0;
  for (const [x, y] of pairs)
    if ((x?.mode === 'parallel-barrier') === (y?.mode === 'parallel-barrier')) agree++;
  return agree / pairs.length;
}

export const verifyMatch = (a: DecisionPlan, b: DecisionPlan) =>
  a.verify.kind === b.verify.kind ? 1 : 0;

export function schemaUsage(a: DecisionPlan, b: DecisionPlan): number {
  const frac = (p: DecisionPlan) => {
    const agents = p.phases.flatMap((ph) => ph.agents);
    return agents.length === 0 ? 0 : agents.filter((ag) => ag.hasSchema).length / agents.length;
  };
  return clamp01(1 - Math.abs(frac(a) - frac(b)));
}

export function dagShape(a: DecisionPlan, b: DecisionPlan): number {
  const sig = (plan: DecisionPlan) => {
    const nodes = new Set<string>();
    const outdeg = new Map<string, number>();
    for (const [from, to] of plan.edges) {
      nodes.add(from);
      nodes.add(to);
      outdeg.set(from, (outdeg.get(from) ?? 0) + 1);
    }
    for (const ph of plan.phases) nodes.add(ph.name);
    const seq = [...nodes].map((n) => outdeg.get(n) ?? 0).sort((x, y) => y - x);
    return { nodes: nodes.size, edges: plan.edges.length, seq };
  };
  const sa = sig(a);
  const sb = sig(b);
  const nodeScore = ratioDelta(sa.nodes, sb.nodes);
  const edgeScore = ratioDelta(sa.edges, sb.edges);
  const len = Math.max(sa.seq.length, sb.seq.length);
  let l1 = 0;
  let mass = 0;
  for (let i = 0; i < len; i++) {
    const x = sa.seq[i] ?? 0;
    const y = sb.seq[i] ?? 0;
    l1 += Math.abs(x - y);
    mass += Math.max(x, y);
  }
  const degScore = mass === 0 ? 1 : clamp01(1 - l1 / mass);
  return (nodeScore + edgeScore + degScore) / 3;
}

const METRIC_FNS: Record<string, (a: DecisionPlan, b: DecisionPlan) => number> = {
  pattern_match: patternMatch,
  phase_count_delta: phaseCountDelta,
  axis_match: axisMatch,
  fanout_width_delta: fanoutWidthDelta,
  barrier_placement: barrierPlacement,
  verify_match: verifyMatch,
  schema_usage: schemaUsage,
  dag_shape: dagShape,
};

export interface StructuralDiffResult {
  score: number;
  perMetric: Record<string, number>;
  weights: Record<string, number>;
}

export function computeStructuralDiff(
  a: DecisionPlan,
  b: DecisionPlan,
  opts: { metrics?: string[]; weights?: Record<string, number> } = {},
): StructuralDiffResult {
  const metrics = opts.metrics ?? Object.keys(METRIC_FNS);
  const weights = opts.weights ?? DEFAULT_WEIGHTS;
  const perMetric: Record<string, number> = {};
  let num = 0;
  let den = 0;
  for (const m of metrics) {
    const fn = METRIC_FNS[m];
    if (!fn) continue;
    const v = fn(a, b);
    perMetric[m] = v;
    const w = weights[m] ?? 1;
    num += v * w;
    den += w;
  }
  return { score: den === 0 ? 0 : num / den, perMetric, weights };
}

/** The §9.1 vertical-slice scorer: pattern_match + dag_shape only. */
export const sliceScore = (a: DecisionPlan, b: DecisionPlan) =>
  computeStructuralDiff(a, b, { metrics: ['pattern_match', 'dag_shape'] });
