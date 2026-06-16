import type { PipelineDefinition } from '../types/agent-orchestrator';
import type { BoilerplateType } from '../boilerplates/registry';
import type { PlanRigor } from '../types/plan';
import type { ConceptArtifactDepth } from '../concept/concept-plan';
import { buildAgentConfig } from './role-policy';
import { buildArchGenPrompt } from '../prompts/arch-gen-prompt';

/**
 * Concept v2 (E7.4, §7) — the Architecture artifact pipeline. A single Architect
 * step emitting `architecture.md` into `variables.ARCHITECTURE_MD`. Post-completion
 * the daemon runs `generateSectionManifest` (E4.1) over the markdown to write the
 * `.md` + `.sections.json` sidecar and registers the artifact `{rev,contentHash}`
 * on the Plan row (E4.4 versioning).
 *
 * Runs only when the conceptPlan includes an `architecture` artifact; the caller
 * passes the resolved depth + uiBearing from the conceptPlan, and (for `change`
 * plans, E7.5) any graph ground-truth.
 */
export function generateArchGenPipeline(args: {
  intent: string;
  boilerplateType: BoilerplateType;
  rigor: PlanRigor;
  depth: ConceptArtifactDepth;
  uiBearing: boolean;
  priorArtifacts?: string;
  groundTruth?: string;
  model?: string;
}): PipelineDefinition {
  const prompt = buildArchGenPrompt(args);
  return {
    maxIterations: 2,
    agents: {
      ARCHITECT: buildAgentConfig({
        boilerplateKind: args.boilerplateType,
        rigor: args.rigor,
        role: 'PM',
        name: 'Architect (Winston)',
        model: args.model || 'sonnet',
      }),
    },
    steps: [
      {
        id: 'arch-gen',
        agentId: 'ARCHITECT',
        prompt,
        extractors: {
          ARCHITECTURE_MD: {
            type: 'between',
            startDelimiter: '---ARCHITECTURE_MD---',
            endDelimiter: '---END_ARCHITECTURE_MD---',
          },
        },
        validations: [],
      },
    ],
  };
}
