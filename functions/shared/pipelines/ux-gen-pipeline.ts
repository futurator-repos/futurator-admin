import type { PipelineDefinition } from '../types/agent-orchestrator';
import type { BoilerplateType } from '../boilerplates/registry';
import type { PlanRigor } from '../types/plan';
import type { ConceptArtifactDepth } from '../concept/concept-plan';
import { buildAgentConfig } from './role-policy';
import { buildUxGenPrompt } from '../prompts/ux-gen-prompt';

/**
 * Concept v2 (E2 / Story 2.2) — the UX artifact pipeline (UX / Sally). A single
 * autopilot step emitting `ux-spec.md` into `variables.UX_MD`. Post-completion
 * the apply path (Story 2.4) write-backs `ux-spec.md` + `ux-spec.sections.json`
 * and registers `{rev,contentHash}` on the Plan row (E1.3).
 *
 * Clone of the generic single-step template (no new daemon jobType). Enqueued
 * only when `conceptPlan.uiBearing` (gate owned by the Concept Reducer, E3) —
 * this builder is applicability-agnostic. `priorArtifacts` carries the inlined
 * approved PRD sections, filled daemon-side (Story 3.2a).
 */
export function generateUxGenPipeline(args: {
  intent: string;
  boilerplateType: BoilerplateType;
  rigor: PlanRigor;
  depth: ConceptArtifactDepth;
  priorArtifacts?: string;
  model?: string;
}): PipelineDefinition {
  const prompt = buildUxGenPrompt(args);
  return {
    maxIterations: 2,
    agents: {
      UX: buildAgentConfig({
        boilerplateKind: args.boilerplateType,
        rigor: args.rigor,
        role: 'DOC_GEN',
        name: 'UX (Sally)',
        model: args.model || 'sonnet',
      }),
    },
    steps: [
      {
        id: 'ux-gen',
        agentId: 'UX',
        prompt,
        extractors: {
          UX_MD: {
            type: 'between',
            startDelimiter: '---UX_MD---',
            endDelimiter: '---END_UX_MD---',
          },
        },
        validations: [],
      },
    ],
  };
}
