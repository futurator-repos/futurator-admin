import type { PipelineDefinition } from '../types/agent-orchestrator';
import { buildPmPlanPrompt } from '../prompts/pm-plan-prompt';
import type { BoilerplateType } from '../boilerplates/registry';
import type { PlanRigor } from '../types/plan';

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
}): PipelineDefinition {
  const prompt = buildPmPlanPrompt(args);
  return {
    maxIterations: 2,
    agents: {
      PM: {
        name: 'Product Manager',
        allowedTools: 'Read',
        model: args.devModel || 'sonnet',
      },
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
