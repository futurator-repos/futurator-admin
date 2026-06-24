// structural-diff.mjs — Scorer 1 (design doc §6). Compares two DecisionPlans, not prose.
// Each metric is 0–1. The slice (§9.1) reports only pattern_match + dag_shape; the full set is
// implemented here as pure functions so M4 can switch them on without new code.
//
// Phase alignment for per-phase metrics is INDEX-BASED for the slice. The design-doc upgrade is
// Needleman–Wunsch over phase names (§6) — swap `alignByIndex` for that when it lands.

const clamp01 = (x) => Math.max(0, Math.min(1, x));
const ratioDelta = (a, b) => {
  const m = Math.max(Math.abs(a), Math.abs(b));
  return m === 0 ? 1 : clamp01(1 - Math.abs(a - b) / m);
};

const DEFAULT_WEIGHTS = {
  pattern_match: 3,
  phase_count_delta: 1,
  axis_match: 2,
  fanout_width_delta: 1,
  barrier_placement: 2,
  verify_match: 2,
  schema_usage: 1,
  dag_shape: 2,
};

/** Tokenize an axis label into a comparable set (e.g. 'review-dimensions' → {review,dimensions}). */
function axisTokens(axis) {
  return new Set(String(axis || '').toLowerCase().split(/[-_\s]+/).filter(Boolean));
}
function jaccard(a, b) {
  if (a.size === 0 && b.size === 0) return 1;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  const union = a.size + b.size - inter;
  return union === 0 ? 1 : inter / union;
}

/** Index-based alignment of two phase arrays → array of [phaseA|null, phaseB|null]. */
function alignByIndex(pa, pb) {
  const n = Math.max(pa.length, pb.length);
  const out = [];
  for (let i = 0; i < n; i++) out.push([pa[i] ?? null, pb[i] ?? null]);
  return out;
}

// ── individual metrics ─────────────────────────────────────────────────────────
export function patternMatch(a, b) { return a.pattern === b.pattern ? 1 : 0; }

export function phaseCountDelta(a, b) { return ratioDelta(a.phases.length, b.phases.length); }

export function axisMatch(a, b) {
  const pairs = alignByIndex(a.phases, b.phases).filter(([x, y]) => x?.fanOut || y?.fanOut);
  if (pairs.length === 0) return 1; // neither fans out → trivially agree
  const scores = pairs.map(([x, y]) => jaccard(axisTokens(x?.fanOut?.axis), axisTokens(y?.fanOut?.axis)));
  return scores.reduce((s, v) => s + v, 0) / scores.length;
}

export function fanoutWidthDelta(a, b) {
  const pairs = alignByIndex(a.phases, b.phases).filter(
    ([x, y]) =>
      typeof x?.fanOut?.width === 'number' && typeof y?.fanOut?.width === 'number',
  );
  if (pairs.length === 0) return 1; // no comparable (static) widths → not penalized
  const scores = pairs.map(([x, y]) => ratioDelta(x.fanOut.width, y.fanOut.width));
  return scores.reduce((s, v) => s + v, 0) / scores.length;
}

export function barrierPlacement(a, b) {
  const pairs = alignByIndex(a.phases, b.phases);
  if (pairs.length === 0) return 1;
  let agree = 0;
  for (const [x, y] of pairs) {
    const bx = x?.mode === 'parallel-barrier';
    const by = y?.mode === 'parallel-barrier';
    if (bx === by) agree++;
  }
  return agree / pairs.length;
}

export function verifyMatch(a, b) { return a.verify.kind === b.verify.kind ? 1 : 0; }

export function schemaUsage(a, b) {
  const frac = (p) => {
    const agents = p.phases.flatMap((ph) => ph.agents);
    return agents.length === 0 ? 0 : agents.filter((ag) => ag.hasSchema).length / agents.length;
  };
  return clamp01(1 - Math.abs(frac(a) - frac(b)));
}

/**
 * dag_shape — name-agnostic graph-shape similarity (the slice metric).
 * Phase names differ across engines, so we compare topological signatures rather than labels:
 * node count, edge count, and the sorted out-degree sequence (normalized L1 distance).
 */
export function dagShape(a, b) {
  const sig = (plan) => {
    const nodes = new Set();
    const outdeg = new Map();
    for (const [from, to] of plan.edges) {
      nodes.add(from); nodes.add(to);
      outdeg.set(from, (outdeg.get(from) ?? 0) + 1);
    }
    for (const ph of plan.phases) nodes.add(ph.name);
    const seq = [...nodes].map((n) => outdeg.get(n) ?? 0).sort((x, y) => y - x);
    return { nodes: nodes.size, edges: plan.edges.length, seq };
  };
  const sa = sig(a), sb = sig(b);
  const nodeScore = ratioDelta(sa.nodes, sb.nodes);
  const edgeScore = ratioDelta(sa.edges, sb.edges);
  // degree-sequence distance (pad shorter with zeros)
  const len = Math.max(sa.seq.length, sb.seq.length);
  let l1 = 0, mass = 0;
  for (let i = 0; i < len; i++) {
    const x = sa.seq[i] ?? 0, y = sb.seq[i] ?? 0;
    l1 += Math.abs(x - y); mass += Math.max(x, y);
  }
  const degScore = mass === 0 ? 1 : clamp01(1 - l1 / mass);
  return (nodeScore + edgeScore + degScore) / 3;
}

const METRIC_FNS = {
  pattern_match: patternMatch,
  phase_count_delta: phaseCountDelta,
  axis_match: axisMatch,
  fanout_width_delta: fanoutWidthDelta,
  barrier_placement: barrierPlacement,
  verify_match: verifyMatch,
  schema_usage: schemaUsage,
  dag_shape: dagShape,
};

/**
 * Compute the structural diff.
 * @param {import('./decision-schema.mjs').DecisionPlan} a
 * @param {import('./decision-schema.mjs').DecisionPlan} b
 * @param {{metrics?: string[], weights?: Record<string,number>}} [opts]
 * @returns {{score:number, perMetric:Record<string,number>, weights:Record<string,number>}}
 */
export function computeStructuralDiff(a, b, opts = {}) {
  const metrics = opts.metrics ?? Object.keys(METRIC_FNS);
  const weights = opts.weights ?? DEFAULT_WEIGHTS;
  const perMetric = {};
  let num = 0, den = 0;
  for (const m of metrics) {
    const fn = METRIC_FNS[m];
    if (!fn) continue;
    const v = fn(a, b);
    perMetric[m] = v;
    const w = weights[m] ?? 1;
    num += v * w; den += w;
  }
  return { score: den === 0 ? 0 : num / den, perMetric, weights };
}

/** The §9.1 vertical-slice scorer: only pattern_match + dag_shape. */
export function sliceScore(a, b) {
  return computeStructuralDiff(a, b, { metrics: ['pattern_match', 'dag_shape'] });
}
