import type { PipelineDefinition } from '../types/agent-orchestrator';
import type { BoilerplateType } from '../boilerplates/registry';
import type { PlanRigor } from '../types/plan';
import type { PlanKind } from '../schemas/plan-schema';
import { buildAgentConfig } from './role-policy';
import { buildConceptRoutePrompt } from '../prompts/concept-route-prompt';

/**
 * Concept v2 (E7.1, §3.2) — the Concept Router pipeline. A single fast
 * (Haiku-class) classifier step that emits the `conceptPlan` DAG, captured into
 * `variables.CONCEPT_PLAN_JSON`. Post-completion the API validates it with
 * `conceptPlanSchema` and persists it on the Plan row.
 *
 * IMPORTANT (W8): callers MUST gate this on `shouldRunConceptRoute(plan)` —
 * `prototype` skips the Router entirely (no job, no latency). This builder is
 * only invoked for mvp/production.
 */
export function generateConceptRoutePipeline(args: {
  intent: string;
  boilerplateType: BoilerplateType;
  rigor: PlanRigor;
  kind?: PlanKind;
  model?: string;
}): PipelineDefinition {
  const prompt = buildConceptRoutePrompt(args);
  return {
    maxIterations: 2,
    agents: {
      ROUTER: buildAgentConfig({
        boilerplateKind: args.boilerplateType,
        rigor: args.rigor,
        role: 'PM',
        name: 'Concept Router (Analyst)',
        // Cheap classifier — Haiku-class unless overridden.
        model: args.model || 'haiku',
      }),
    },
    steps: [
      {
        id: 'concept-route',
        agentId: 'ROUTER',
        prompt,
        extractors: {
          CONCEPT_PLAN_JSON: {
            type: 'between',
            startDelimiter: '---CONCEPT_PLAN---',
            endDelimiter: '---END_CONCEPT_PLAN---',
          },
        },
        validations: [],
      },
    ],
  };
}
