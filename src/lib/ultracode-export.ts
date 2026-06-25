/**
 * ultracode-export.ts — builds the per-run JSON export for the Case-2 prompt-improvement loop.
 *
 * Deterministic (no model call): from the two parsed DecisionPlans + tokens/timings on the run,
 * it emits structured FACTS plus one framing per selected GOAL. Goals compound — the export carries
 * a `comparisons[]` array, one entry per goal, each with a goal-specific objective + directional
 * dimensions + a ranked `asks[]` an expert agent can act on. The raw facts are always present so the
 * consuming agent can re-derive any lens.
 */

import type { UltracodeDecisionPlan, UltracodeRun } from '@/types/ultracode-run';

export const EXPORT_GOALS = ['replicate', 'diverge', 'surpass', 'cost-fidelity'] as const;
export type ExportGoal = (typeof EXPORT_GOALS)[number];

export const GOAL_LABEL: Record<ExportGoal, string> = {
  replicate: 'Replicate',
  diverge: 'Diverge',
  surpass: 'Surpass',
  'cost-fidelity': 'Cost-fidelity',
};

const VERIFY_RANK: Record<string, number> = {
  none: 0,
  'perspective-diverse': 2,
  adversarial: 3,
  'judge-panel': 3,
};

export interface PlanSignals {
  pattern: string;
  phases: number;
  agents: number;
  fanoutPhases: number;
  fanoutAxes: string[];
  verifyKind: string;
  verifyRank: number;
  schemaCovered: number;
  schemaPct: number;
  qualityPatterns: string[];
  reduceSteps: number;
  earlyExit: boolean;
}

export function planSignals(plan?: UltracodeDecisionPlan): PlanSignals | null {
  if (!plan) return null;
  const agents = plan.phases.flatMap((p) => p.agents);
  const fan = plan.phases.filter((p) => p.fanOut);
  const verifyKind = plan.verify?.present ? plan.verify.kind : 'none';
  return {
    pattern: plan.pattern,
    phases: plan.phases.length,
    agents: agents.length,
    fanoutPhases: fan.length,
    fanoutAxes: [...new Set(fan.map((p) => p.fanOut!.axis))],
    verifyKind,
    verifyRank: VERIFY_RANK[verifyKind] ?? 0,
    schemaCovered: agents.filter((a) => a.hasSchema).length,
    schemaPct: agents.length ? agents.filter((a) => a.hasSchema).length / agents.length : 0,
    qualityPatterns: plan.qualityPatterns ?? [],
    reduceSteps: plan.reduceSteps,
    earlyExit: plan.earlyExit,
  };
}

type Direction = 'match' | 'case2-weaker' | 'case2-stronger' | 'divergent';

interface Dim {
  lever: string;
  metric: string;
  case1: string;
  case2: string;
  direction: Direction;
  /** Higher = more rigorous; used to derive direction + ideal gaps. */
  rank1: number;
  rank2: number;
  ideal: number; // the "good plan" target for this lever (Surpass)
  cost: 'cheap' | 'expensive'; // ROI of fixing via a prompt edit
  lever_hint: string; // the prompt change that moves this lever
}

function dims(c1: PlanSignals, c2: PlanSignals): Dim[] {
  const dir = (r1: number, r2: number, eq?: boolean): Direction =>
    eq ? 'match' : r2 < r1 ? 'case2-weaker' : r2 > r1 ? 'case2-stronger' : 'match';

  const axisOverlap = c1.fanoutAxes.filter((a) => c2.fanoutAxes.includes(a)).length;
  const axisDir: Direction =
    c1.fanoutAxes.length === 0 && c2.fanoutAxes.length === 0
      ? 'match'
      : axisOverlap > 0
        ? 'match'
        : 'divergent';

  return [
    {
      lever: 'pattern',
      metric: 'pattern_fit',
      case1: c1.pattern,
      case2: c2.pattern,
      direction: c1.pattern === c2.pattern ? 'match' : 'divergent',
      rank1: c1.pattern === 'other' ? 0 : 1,
      rank2: c2.pattern === 'other' ? 0 : 1,
      ideal: 1,
      cost: 'cheap',
      lever_hint:
        'classify the task and pick the matching named skeleton explicitly (e.g. plan-synthesis-critique) rather than improvising structure.',
    },
    {
      lever: 'verification',
      metric: 'verify_rigor',
      case1: c1.verifyKind,
      case2: c2.verifyKind,
      direction: dir(c1.verifyRank, c2.verifyRank, c1.verifyRank === c2.verifyRank),
      rank1: c1.verifyRank,
      rank2: c2.verifyRank,
      ideal: 2, // at least perspective-diverse
      cost: 'cheap',
      lever_hint:
        'add explicit guidance to instantiate a verification phase — perspective-diverse critics or adversarial refuters — and keep survivors.',
    },
    {
      lever: 'structure',
      metric: 'schema_discipline',
      case1: `${c1.schemaCovered}/${c1.agents} (${Math.round(c1.schemaPct * 100)}%)`,
      case2: `${c2.schemaCovered}/${c2.agents} (${Math.round(c2.schemaPct * 100)}%)`,
      direction: dir(
        Math.round(c1.schemaPct * 10),
        Math.round(c2.schemaPct * 10),
        Math.abs(c1.schemaPct - c2.schemaPct) < 0.1,
      ),
      rank1: Math.round(c1.schemaPct * 10),
      rank2: Math.round(c2.schemaPct * 10),
      ideal: 8, // ~80%+
      cost: 'cheap',
      lever_hint:
        'require a `schema` (JSON Schema) on every agent() whose output a later stage consumes.',
    },
    {
      lever: 'decomposition',
      metric: 'fan_out_breadth',
      case1: `${c1.fanoutPhases} fan-out phase(s); ${c1.agents} agents; axes [${c1.fanoutAxes.join(', ') || '—'}]`,
      case2: `${c2.fanoutPhases} fan-out phase(s); ${c2.agents} agents; axes [${c2.fanoutAxes.join(', ') || '—'}]`,
      direction:
        axisDir !== 'match' ? 'divergent' : dir(c1.agents, c2.agents, c1.agents === c2.agents),
      rank1: c1.agents,
      rank2: c2.agents,
      ideal: Math.max(c1.agents, c2.agents),
      cost: 'expensive',
      lever_hint:
        'pick the decomposition axis with maximal independence and fan out one specialist per unit; turn real dependencies into ordered phases, never serialize the whole job.',
    },
    {
      lever: 'coverage',
      metric: 'subagent_count',
      case1: String(c1.agents),
      case2: String(c2.agents),
      direction: dir(c1.agents, c2.agents, c1.agents === c2.agents),
      rank1: c1.agents,
      rank2: c2.agents,
      ideal: Math.max(c1.agents, c2.agents),
      cost: 'expensive',
      lever_hint:
        'enumerate the disciplines/units the task spans and assign a scoped specialist subagent to each.',
    },
  ];
}

const SEVERITY: Record<string, 'high' | 'medium' | 'low'> = {
  verification: 'high',
  pattern: 'high',
  decomposition: 'medium',
  structure: 'medium',
  coverage: 'low',
};

interface Ask {
  lever: string;
  severity: 'high' | 'medium' | 'low';
  cost?: 'cheap' | 'expensive';
  finding: string;
  promptChange: string;
}

interface Comparison {
  goal: ExportGoal;
  objective: string;
  dimensions: Array<{
    lever: string;
    metric: string;
    case1: string;
    case2: string;
    verdict: Direction;
  }>;
  asks: Ask[];
}

function framing(goal: ExportGoal, ds: Dim[]): Comparison {
  const dimensions = ds.map((d) => ({
    lever: d.lever,
    metric: d.metric,
    case1: d.case1,
    case2: d.case2,
    verdict: d.direction,
  }));

  const ask = (d: Dim, finding: string): Ask => ({
    lever: d.lever,
    severity: SEVERITY[d.lever] ?? 'low',
    cost: d.cost,
    finding,
    promptChange: d.lever_hint,
  });

  let objective = '';
  let asks: Ask[] = [];

  if (goal === 'replicate') {
    objective =
      'Reverse-engineer native ultracode (Case 1) into the Case-2 meta-prompt: add what Case 1 has that Case 2 lacks. Ignore where Case 2 already matches or exceeds Case 1.';
    asks = ds
      .filter((d) => d.direction === 'case2-weaker' || d.direction === 'divergent')
      .map((d) =>
        ask(
          d,
          d.direction === 'divergent'
            ? `Case 2 diverged from Case 1 on ${d.lever} (Case 1: ${d.case1}; Case 2: ${d.case2}).`
            : `Case 2 is weaker than Case 1 on ${d.lever} (Case 1: ${d.case1}; Case 2: ${d.case2}).`,
        ),
      );
  } else if (goal === 'surpass') {
    objective =
      'Make Case 2 an excellent plan against an absolute rubric — improve weak levers even where Case 2 already beats Case 1; both plans are reference points.';
    asks = ds
      .filter((d) => d.rank2 < d.ideal)
      .map((d) =>
        ask(
          d,
          `Case 2 is below the quality bar on ${d.lever} (Case 2: ${d.case2}; ideal ≥ ${d.ideal}).`,
        ),
      );
  } else if (goal === 'diverge') {
    objective =
      'Diagnostic only: map WHERE and likely WHY the two plans differ, tied to the meta-prompt — no better/worse, no prescriptions.';
    asks = ds
      .filter((d) => d.direction !== 'match')
      .map((d) => ({
        lever: d.lever,
        severity: SEVERITY[d.lever] ?? 'low',
        finding: `${d.lever}: ${d.direction} (Case 1: ${d.case1}; Case 2: ${d.case2}).`,
        promptChange: `Likely prompt cause: ${d.lever_hint}`,
      }));
  } else {
    objective =
      'Cost-fidelity: close Case-1 gaps in ROI order — cheap prompt-wording wins first, expensive structural changes (wider fan-out / more agents) last.';
    asks = ds
      .filter((d) => d.direction === 'case2-weaker' || d.direction === 'divergent')
      .map((d) => ask(d, `${d.lever} gap (${d.cost}): Case 1 ${d.case1} vs Case 2 ${d.case2}.`))
      .sort((a, b) => (a.cost === b.cost ? 0 : a.cost === 'cheap' ? -1 : 1));
  }

  return { goal, objective, dimensions, asks };
}

export interface UltracodeExport {
  schemaVersion: string;
  exportedAt: string;
  runId: string;
  intent: string;
  target: string;
  rigor: string;
  benchFrame: string;
  metaPromptVersion: string | null;
  metaPrompt: string | null;
  case1: unknown;
  case2: unknown;
  structuralSimilarity: number | null;
  rawMetrics: Record<string, number>;
  comparisons: Comparison[];
}

function caseBlock(
  engine: string,
  plan: UltracodeDecisionPlan | undefined,
  script: string | undefined,
  durationMs: number | undefined,
  tokens: unknown,
  sig: PlanSignals | null,
) {
  return {
    engine,
    plan: plan ?? null,
    script: script ?? null,
    durationMs: durationMs ?? null,
    tokens: tokens ?? null,
    signals: sig,
  };
}

/** Build the export object for one finished run + the selected (compounding) goals. */
export function buildExport(
  run: UltracodeRun,
  goals: ExportGoal[],
  nowIso: string,
): UltracodeExport {
  const c1 = planSignals(run.case1Plan);
  const c2 = planSignals(run.case2Plan);
  const ds = c1 && c2 ? dims(c1, c2) : [];
  const selected = EXPORT_GOALS.filter((g) => goals.includes(g));
  return {
    schemaVersion: 'ultracode-bench-export/1',
    exportedAt: nowIso,
    runId: run.runId,
    intent: run.intent,
    target: run.target,
    rigor: run.rigor,
    benchFrame:
      'claude opus-4.8 · effort max · symmetric frame — only the prompt differs (Case 1 native ultracode, Case 2 our meta-prompt)',
    metaPromptVersion: run.metaPromptVersion ?? null,
    metaPrompt: run.metaPrompt ?? null,
    case1: caseBlock(
      'native-ultracode',
      run.case1Plan,
      run.case1Script,
      run.case1DurationMs,
      run.case1Tokens,
      c1,
    ),
    case2: caseBlock(
      'futurator-meta-prompt',
      run.case2Plan,
      run.case2Script,
      run.case2DurationMs,
      run.case2Tokens,
      c2,
    ),
    structuralSimilarity: run.structuralScore ?? null,
    rawMetrics: run.scorecard?.structural?.perMetric ?? {},
    comparisons: selected.map((g) => framing(g, ds)),
  };
}
