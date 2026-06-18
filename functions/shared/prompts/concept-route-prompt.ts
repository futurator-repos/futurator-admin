import type { PlanRigor } from '../types/plan';
import type { PlanKind } from '../schemas/plan-schema';
import { gateForRigor } from '../concept/concept-plan';

/**
 * Concept v2 (E7.1, §3.2) — the Concept Router prompt (Analyst/Mary persona).
 *
 * An LLM classifier run right after intent. It reads the intent + boilerplate +
 * rigor + kind and emits a `conceptPlan` DAG: which upstream artifacts apply, in
 * what order, and the gate strictness. It is the *applicability* decision; rigor
 * still owns depth. UX is activated iff the app is UI-bearing — NOT by rigor.
 *
 * The classifier authors NO content — only the routing DAG. Cheap/fast
 * (Haiku-class). Its `rationale` is logged so routing is auditable.
 */
export function buildConceptRoutePrompt(args: {
  intent: string;
  boilerplateType: string;
  rigor: PlanRigor;
  kind?: PlanKind;
}): string {
  const gate = gateForRigor(args.rigor);
  return `You are the Concept Router (Analyst persona). Classify the build intent
into a conceptPlan — the ordered set of upstream planning artifacts that apply.
You do NOT write any artifact; you only decide WHICH apply and their order.

## Intent
${args.intent}

## Signals
- Boilerplate: ${args.boilerplateType}
- Rigor: ${args.rigor}   (depth dial — NOT your concern; you decide applicability)
- Kind: ${args.kind ?? 'new'}

## Rules
- **uiBearing**: true iff the app renders a user interface (screens, canvas, HUD,
  forms, dashboard). A CLI / library / pure-backend service is false.
- **UX applies iff uiBearing** — never gate UX on rigor. When uiBearing, ordering
  is SERIAL: prd → ux → architecture (architecture cites the UX spec).
  When not uiBearing: prd → architecture, and UX is OMITTED entirely.
- **architecture applies** when the app has more than trivial structure
  (multiple subsystems, external services, persistence). A throwaway one-screen
  toy may omit it.
- **prd** applies for every routed plan.
- **complexity**: low | medium | high — your read of structural footprint.
- **gate**: emit exactly "${gate}" (derived from rigor).
- **rationale**: ONE line explaining the routing decision.

## Output — between the fences, nothing else. Double quotes. No trailing commas.
---CONCEPT_PLAN---
{
  "uiBearing": true,
  "complexity": "medium",
  "artifacts": [
    { "kind": "prd", "depth": "full" },
    { "kind": "ux", "depth": "light", "dependsOn": ["prd"] },
    { "kind": "architecture", "depth": "full", "dependsOn": ["prd", "ux"] }
  ],
  "gate": "${gate}",
  "rationale": "<one line>"
}
---END_CONCEPT_PLAN---`;
}
