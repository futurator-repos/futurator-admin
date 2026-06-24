/**
 * Orchestrate one bench run's scoring — the entry point the API (and later the daemon) calls.
 * Reuses the TS scorer ports. For the M2 path there is no captured Case-1 yet, so `case1Plan`
 * defaults to a degenerate empty plan and the meaningful signal is the Case-2 guardrail uplift.
 */

import { makeDecisionPlan, type DecisionPlan } from './decision-plan';
import { case2Project, type Case2Ctx, type PlanOutputInput } from './case2-project';
import { computeStructuralDiff } from './structural-diff';
import { guardrailUplift } from './guardrail-uplift';
import { emitSlices } from './scorecard-emit';
import type { UltracodeScorecard } from '../types/ultracode-run';

/** Verdict thresholds (rubric §7.4). Only meaningful once a real Case-1 is present. */
function verdictFor(structuralScore: number, guardrailUplift: number, hasCase1: boolean): string {
  if (!hasCase1) return 'awaiting-case1';
  if (structuralScore >= 0.7) return guardrailUplift >= 0.8 ? 'case2-wins' : 'case2-matches';
  return 'case2-gaps';
}

export interface ScoreRunArgs {
  runId: string;
  planOutput: PlanOutputInput;
  ctx?: Case2Ctx;
  /** The captured Case-1 plan (M3+). Absent ⇒ M2 path: guardrail-only signal. */
  case1Plan?: DecisionPlan | null;
  validatorPassed?: boolean;
}

export interface ScoredRun {
  scorecard: UltracodeScorecard;
  case1Pattern?: string;
  case2Pattern: string;
  structuralScore: number;
  guardrailUplift: number;
}

export function scoreRun(args: ScoreRunArgs): ScoredRun {
  const { runId, planOutput, ctx, validatorPassed } = args;
  const { plan: case2Plan } = case2Project(planOutput, ctx);
  const hasCase1 = Boolean(args.case1Plan);
  const case1Plan = args.case1Plan ?? makeDecisionPlan({ source: 'case1-script' });

  const structural = computeStructuralDiff(case1Plan, case2Plan, {
    metrics: ['pattern_match', 'dag_shape'],
  });
  const guardrail = guardrailUplift(case2Plan, planOutput, { validatorPassed });
  const slices = emitSlices({ structural, guardrail, runId });
  const verdict = verdictFor(structural.score, guardrail.uplift, hasCase1);

  const observations: string[] = [];
  if (!hasCase1)
    observations.push('Case 1 not captured yet — structural diff is provisional (M2 path).');
  observations.push(
    'Confound: Case 2 is the cost-tiered chain, not a single-shot xhigh-Opus challenger.',
  );

  const scorecard: UltracodeScorecard = {
    structural: { score: structural.score, perMetric: structural.perMetric },
    guardrail: { uplift: guardrail.uplift, sub: guardrail.sub },
    slices,
    verdict,
    observations,
  };

  return {
    scorecard,
    case1Pattern: hasCase1 ? case1Plan.pattern : undefined,
    case2Pattern: case2Plan.pattern,
    structuralScore: structural.score,
    guardrailUplift: guardrail.uplift,
  };
}
