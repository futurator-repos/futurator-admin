import type { PipelineDefinition } from '../types/agent-orchestrator';
import { buildPmPlanPrompt } from '../prompts/pm-plan-prompt';
import type { BoilerplateType } from '../boilerplates/registry';
import type { PlanRigor } from '../types/plan';
import type { PlanKind } from '../schemas/plan-schema';
import { buildAgentConfig } from './role-policy';

/**
 * PM-plan pipeline — single-step agent invocation that outputs Plan JSON.
 *
 * The JSON is captured into `variables.PLAN_JSON` via the between-delimiter
 * extractor. Post-completion, the API's `applyPlanOutput` handler validates
 * + persists it.
 *
 * Pipeline v2.0 PR-5: now boilerplate-aware. `boilerplateType` is required —
 * pass `appRow.boilerplateType` (or `'nextjs'` as a default for legacy plans
 * without an App). `rigor` defaults to `'mvp'` if the Plan doesn't carry one.
 *
 * `maxIterations: 2` gives the agent one retry (cheap); real retries should
 * be driven by the operator re-clicking Regenerate.
 */
export function generatePmPlanPipeline(args: {
  planName: string;
  intent: string;
  executionMode: 'pipeline' | 'orchestrator';
  devModel?: string;
  boilerplateType: BoilerplateType;
  rigor: PlanRigor;
  /**
   * PR-23d — pass plan kind through so the PM prompt can render the
   * brownfield clause for `change` plans.
   *
   * PR-39 (Story 2-A-7-1) — extended with the Phase 2 kinds. PM prompt
   * builder is responsible for branching on the new kinds; until that
   * landed, the prompt uses the brownfield clause for any kind in
   * { 'change', 'feature', 'bugfix', 'maintenance' } (i.e. anything
   * acting on an existing App).
   */
  kind?: PlanKind;
  /**
   * Concept v2 (E5.1) — true when the plan is concept-chain-bearing and the PM
   * should cite real sections. Emits the daemon-fillable `{{CITABLE_SECTIONS}}`
   * placeholder (the daemon substitutes real ids at run time, Story 5.2).
   */
  expectsCitations?: boolean;
}): PipelineDefinition {
  const prompt = buildPmPlanPrompt(args);
  return {
    maxIterations: 2,
    agents: {
      // PR-32 — PM allowlist resolved from typed RolePolicy.
      PM: buildAgentConfig({
        boilerplateKind: args.boilerplateType,
        rigor: args.rigor,
        role: 'PM',
        name: 'Product Manager',
        model: args.devModel || 'sonnet',
      }),
    },
    steps: [
      {
        id: 'pm-plan',
        agentId: 'PM',
        prompt,
        extractors: {
          PLAN_JSON: {
            type: 'between',
            startDelimiter: '---PLAN_JSON---',
            endDelimiter: '---END_PLAN_JSON---',
          },
        },
        validations: [],
      },
    ],
  };
}
