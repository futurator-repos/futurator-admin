import type { ConceptInteraction, Plan, PlanRigor } from '../types/plan';

/**
 * Concept v2 (W11) — resolve the effective interactivity mode for a plan.
 *
 * The interactivity axis is orthogonal to `rigor` (depth) and the Concept Router
 * (applicability). When the operator hasn't set it explicitly, we default by
 * rigor: a throwaway `prototype` runs hands-off (`autopilot`), while `mvp` /
 * `production` plans converge each artifact in a chat with an Approve gate
 * (`interactive`). The operator may always override per-plan.
 *
 * This is plumbing only — no behavior depends on it until Epic E7/E12 wire the
 * artifact jobs. See `docs/concepts/pipeline-v3/concept-stage-v2-bmad.md` §3.3.
 * Sibling of `cost-ceiling-defaults.ts` (the other rigor-derived default).
 */
export function resolveConceptInteraction(
  plan: Pick<Plan, 'conceptInteraction' | 'rigor'>,
): ConceptInteraction {
  if (plan.conceptInteraction) return plan.conceptInteraction;
  return defaultConceptInteractionForRigor(plan.rigor);
}

/** The rigor-derived default when a plan carries no explicit `conceptInteraction`. */
export function defaultConceptInteractionForRigor(
  rigor: PlanRigor | undefined,
): ConceptInteraction {
  return rigor === 'prototype' ? 'autopilot' : 'interactive';
}
