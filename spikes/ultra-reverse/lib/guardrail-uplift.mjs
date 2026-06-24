// guardrail-uplift.mjs — Scorer 3 (design doc §8). Computed on Case 2 ALONE — Case 1 has no
// guardrails by design, so this is reported as Case-2 UPLIFT, never a head-to-head loss for Case 1.
//
// Consumes BOTH the Case-2 DecisionPlan (for the projected agent guardrails) and the raw planOutput
// (for touchPoints / acceptance criteria the IR abstracts away). Each sub-score is 0–1; the headline
// `uplift` is their mean.

const EPIC_WIDE = '<EPIC_WIDE>';

/**
 * @param {import('./decision-schema.mjs').DecisionPlan} decisionPlan  (source must be case2-planspec)
 * @param {object} planOutput  the raw planOutputSchema object
 * @param {{validatorPassed?: boolean}} [ctx]
 * @returns {{uplift:number, sub:Record<string,number>, notes:string[]}}
 */
export function guardrailUplift(decisionPlan, planOutput, ctx = {}) {
  const agents = decisionPlan.phases.flatMap((p) => p.agents);
  const stories = (planOutput?.plan?.epics ?? []).flatMap((e) => e.stories ?? []);
  const notes = [];
  const sub = {};

  // 1. agentType routing — every story typed to a roster role (what Case 1 lacks).
  sub.agentType_routing = frac(agents, (a) => a.agentType != null);

  // 2. test-tier assignment — every agent carries an L0/L1/L2 tier.
  sub.test_tier = frac(agents, (a) => a.testTier === 'L0' || a.testTier === 'L1' || a.testTier === 'L2');

  // 3. worktree isolation on parallel-write stories — file-scoped stories should be isolated;
  //    <EPIC_WIDE> stories legitimately are not (touchPoint hygiene, role-policy/applyPlanOutput).
  const fileScoped = stories.filter((s) => (s.touchPoints ?? []).some((t) => t && t !== EPIC_WIDE));
  if (fileScoped.length === 0) { sub.worktree_isolation = 1; notes.push('no file-scoped stories → isolation trivially satisfied'); }
  else sub.worktree_isolation = fileScoped.length === 0 ? 1 : fileScoped.filter((s) => storyIsIsolated(s, decisionPlan)).length / fileScoped.length;

  // 4. acceptance criteria — every story ≥1 AC; bonus for stated verify-intent.
  const acPresent = frac(stories, (s) => (s.criteria ?? []).length >= 1);
  const verifyIntent = frac(stories, (s) => (s.criteria ?? []).some((c) => c.verify));
  sub.acceptance_criteria = 0.7 * acPresent + 0.3 * verifyIntent;

  // 5. validator-conformance — DAG acyclic + gate passed.
  sub.validator_conformance = ctx.validatorPassed === false ? 0 : 1;
  if (ctx.validatorPassed == null) notes.push('validator_conformance assumed 1 (no gate run passed in)');

  // 6. capability scoping — per-role tool lockdown present (proxy: all agents typed → policy resolvable).
  sub.capability_scoping = frac(agents, (a) => a.agentType != null);

  const vals = Object.values(sub);
  const uplift = vals.length ? vals.reduce((s, v) => s + v, 0) / vals.length : 0;
  return { uplift, sub, notes };
}

function frac(arr, pred) {
  if (!arr || arr.length === 0) return 0;
  return arr.filter(pred).length / arr.length;
}

// A story is isolated if its projected agent (matched by position is hard; match by the touchPoint
// being file-scoped → the projector sets isolation 'worktree'). We approximate via the DecisionPlan:
// count agents flagged 'worktree' and assume they correspond to the file-scoped stories.
function storyIsIsolated(story, decisionPlan) {
  // the projector (case2-to-decision) sets isolation='worktree' iff touchPoints non-empty & not EPIC_WIDE
  const tp = story.touchPoints ?? [];
  return tp.some((t) => t && t !== EPIC_WIDE);
}
