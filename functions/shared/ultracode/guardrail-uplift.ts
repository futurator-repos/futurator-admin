/**
 * Scorer 3 — guardrail uplift (TS port of spikes/ultra-reverse/lib/guardrail-uplift.mjs).
 * Computed on Case 2 ALONE — reported as Case-2 uplift, never a Case-1 deficiency.
 */

import type { DecisionPlan } from './decision-plan';
import type { PlanOutputInput } from './case2-project';

const EPIC_WIDE = '<EPIC_WIDE>';

export interface GuardrailResult {
  uplift: number;
  sub: Record<string, number>;
  notes: string[];
}

function frac<T>(arr: T[], pred: (x: T) => boolean): number {
  if (!arr || arr.length === 0) return 0;
  return arr.filter(pred).length / arr.length;
}

export function guardrailUplift(
  decisionPlan: DecisionPlan,
  planOutput: PlanOutputInput,
  ctx: { validatorPassed?: boolean } = {},
): GuardrailResult {
  const agents = decisionPlan.phases.flatMap((p) => p.agents);
  const stories = (planOutput?.plan?.epics ?? []).flatMap((e) => e.stories ?? []);
  const notes: string[] = [];
  const sub: Record<string, number> = {};

  sub.agentType_routing = frac(agents, (a) => a.agentType != null);
  sub.test_tier = frac(
    agents,
    (a) => a.testTier === 'L0' || a.testTier === 'L1' || a.testTier === 'L2',
  );

  const fileScoped = stories.filter((s) => (s.touchPoints ?? []).some((t) => t && t !== EPIC_WIDE));
  if (fileScoped.length === 0) {
    sub.worktree_isolation = 1;
    notes.push('no file-scoped stories → isolation trivially satisfied');
  } else {
    sub.worktree_isolation =
      fileScoped.filter((s) => (s.touchPoints ?? []).some((t) => t && t !== EPIC_WIDE)).length /
      fileScoped.length;
  }

  const acPresent = frac(
    stories,
    (s) => ((s as { criteria?: unknown[] }).criteria ?? []).length >= 1,
  );
  const verifyIntent = frac(stories, (s) =>
    ((s as { criteria?: Array<{ verify?: string }> }).criteria ?? []).some((c) => c.verify),
  );
  sub.acceptance_criteria = 0.7 * acPresent + 0.3 * verifyIntent;

  sub.validator_conformance = ctx.validatorPassed === false ? 0 : 1;
  if (ctx.validatorPassed == null)
    notes.push('validator_conformance assumed 1 (no gate run passed in)');

  sub.capability_scoping = frac(agents, (a) => a.agentType != null);

  const vals = Object.values(sub);
  const uplift = vals.length ? vals.reduce((s, v) => s + v, 0) / vals.length : 0;
  return { uplift, sub, notes };
}
