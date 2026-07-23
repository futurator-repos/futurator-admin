/**
 * Agentic Document Center — E2.3 (W2): the propose-only LLM classifier pipeline.
 *
 * A generic single-step pipeline (no new daemon jobType) cloned from the
 * Reflector/Concept-Router template. Runs ONLY for artifacts the deterministic
 * layer could not classify. Output is a PROPOSED decision the operator triages.
 */
import type { PipelineDefinition } from '../types/agent-orchestrator';
import type { BoilerplateType } from '../boilerplates/registry';
import type { PlanRigor } from '../types/plan';
import { buildAgentConfig } from './role-policy';
import {
  buildDocRouterPrompt,
  DOC_ROUTER_DECISION_START,
  DOC_ROUTER_DECISION_END,
  type DocRouterPromptArgs,
} from '../prompts/doc-router-prompt';

export interface DocRouterPipelineArgs extends DocRouterPromptArgs {
  boilerplateKind: BoilerplateType;
  rigor: PlanRigor;
  /** Override model — Haiku is plenty for classification. */
  model?: string;
}

export function generateDocRouterPipeline(args: DocRouterPipelineArgs): PipelineDefinition {
  const prompt = buildDocRouterPrompt({
    artifactRef: args.artifactRef,
    artifactExcerpt: args.artifactExcerpt,
    knownDocTypes: args.knownDocTypes,
  });

  return {
    maxIterations: 2,
    agents: {
      DOC_ROUTER: buildAgentConfig({
        boilerplateKind: args.boilerplateKind,
        rigor: args.rigor,
        // Propose-only classifier — reuse the REFLECTOR capability bucket
        // (read-only, no Write/Edit/Bash) since it must not act on its decision.
        role: 'REFLECTOR',
        name: 'Doc Router',
        model: args.model || 'haiku',
      }),
    },
    steps: [
      {
        id: 'doc-router-classify',
        agentId: 'DOC_ROUTER',
        prompt,
        extractors: {
          DOC_ROUTER_DECISION_JSON: {
            type: 'between',
            startDelimiter: DOC_ROUTER_DECISION_START,
            endDelimiter: DOC_ROUTER_DECISION_END,
          },
        },
        validations: [],
      },
    ],
  };
}
