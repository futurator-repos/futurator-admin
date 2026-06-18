import type { PipelineDefinition } from '../types/agent-orchestrator';
import type { BoilerplateType } from '../boilerplates/registry';
import type { PlanRigor } from '../types/plan';
import type { ConceptArtifactDepth } from '../concept/concept-plan';
import { buildAgentConfig } from './role-policy';
import { buildPrdGenPrompt } from '../prompts/prd-gen-prompt';

/**
 * Concept v2 (E2 / Story 2.1) — the PRD artifact pipeline (PM / John). A single
 * autopilot step emitting `prd.md` into `variables.PRD_MD`. Post-completion the
 * apply path (Story 2.4) runs write-back (E1.2) over the markdown to land
 * `prd.md` + `prd.sections.json` and registers `{rev,contentHash}` on the Plan
 * row (E1.3).
 *
 * A clone of `generateConceptRoutePipeline` — same generic single-step template,
 * NO new daemon jobType. The extractor delimiters MUST match the prompt fences
 * byte-for-byte (a typo silently yields an undefined variable — the parity test
 * is the guard).
 */
export function generatePrdGenPipeline(args: {
  intent: string;
  boilerplateType: BoilerplateType;
  rigor: PlanRigor;
  depth: ConceptArtifactDepth;
  priorArtifacts?: string;
  model?: string;
}): PipelineDefinition {
  const prompt = buildPrdGenPrompt(args);
  return {
    maxIterations: 2,
    agents: {
      PRD: buildAgentConfig({
        boilerplateKind: args.boilerplateType,
        rigor: args.rigor,
        role: 'DOC_GEN',
        name: 'PRD (John)',
        model: args.model || 'sonnet',
      }),
    },
    steps: [
      {
        id: 'prd-gen',
        agentId: 'PRD',
        prompt,
        extractors: {
          PRD_MD: {
            type: 'between',
            startDelimiter: '---PRD_MD---',
            endDelimiter: '---END_PRD_MD---',
          },
        },
        validations: [],
      },
    ],
  };
}
