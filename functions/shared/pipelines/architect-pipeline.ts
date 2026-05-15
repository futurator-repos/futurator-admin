/**
 * architect-pipeline.ts — Pipeline v2 Phase 2-D / Story 2-D-6-1 (PR-90).
 *
 * Single-step pipeline definition for ARCHITECT. Mirror of SKILL-SCOUT
 * (PR-72): the agent emits a `---ARCHITECT_PROPOSAL---` block between
 * markers; the daemon-side runner (architect-runner.mjs) parses + applies.
 */

import type { PipelineDefinition } from '../types/agent-orchestrator';
import { buildArchitectPrompt, type ArchitectTrigger } from '../prompts/architect-prompt';
import type { BoilerplateType } from '../boilerplates/registry';
import type { PlanRigor } from '../types/plan';
import { buildAgentConfig } from './role-policy';
import { z } from 'zod';

export const AwsChangeSchema = z.object({
  kind: z.enum(['add', 'remove', 'upgrade']),
  scope: z.enum(['shared', 'environments.dev', 'environments.staging', 'environments.production']),
  // Permissive — the wrapped value is a YAML-equivalent service entry
  // that's already shape-checked by the AWS manifest schema downstream.
  service: z.unknown(),
  rationale: z.string().min(1),
  monthlyCostUsd: z.number().min(0).default(0),
  'implies-skills': z.array(z.string()).default([]),
  confidence: z.number().min(0).max(1),
});

export const IntegrationChangeSchema = z.object({
  kind: z.enum(['add', 'remove', 'upgrade']),
  integration: z.unknown(),
  rationale: z.string().min(1),
  confidence: z.number().min(0).max(1),
});

export const SpeculationHintSchema = z.object({
  id: z.string().min(1),
  description: z.string().min(1),
  approaches: z
    .array(
      z.object({
        id: z.string().min(1),
        description: z.string().min(1),
        'rough-monthlyCostUsd': z.number().min(0).default(0),
      }),
    )
    .min(2),
});

export const ArchitectOutputSchema = z.object({
  trigger: z.enum(['T1', 'T2', 'T3']),
  projectSlug: z.string().min(1),
  awsChanges: z.array(AwsChangeSchema).default([]),
  integrationChanges: z.array(IntegrationChangeSchema).default([]),
  speculations: z.array(SpeculationHintSchema).default([]),
});
export type ArchitectOutput = z.infer<typeof ArchitectOutputSchema>;

export function validateArchitectProposalBlock(
  raw: string,
): { ok: true; output: ArchitectOutput } | { ok: false; error: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    return { ok: false, error: `JSON parse failed: ${(e as Error).message}` };
  }
  const result = ArchitectOutputSchema.safeParse(parsed);
  if (!result.success) {
    const issue = result.error.issues[0];
    const path = issue?.path?.join('.') || '<root>';
    return { ok: false, error: `${path}: ${issue?.message ?? 'unknown shape error'}` };
  }
  return { ok: true, output: result.data };
}

export interface ArchitectPipelineArgs {
  trigger: ArchitectTrigger;
  projectSlug: string;
  planIntent?: string;
  boilerplateKind: BoilerplateType;
  rigor: PlanRigor;
  currentAwsManifestYaml: string;
  currentIntegrationsManifestYaml: string;
  brownfieldResourceScan?: string;
  /** Override model — Sonnet default; Opus when manifest empty (greenfield T1). */
  model?: string;
}

export function generateArchitectPipeline(args: ArchitectPipelineArgs): PipelineDefinition {
  const prompt = buildArchitectPrompt({
    trigger: args.trigger,
    projectSlug: args.projectSlug,
    planIntent: args.planIntent,
    boilerplateKind: args.boilerplateKind,
    currentAwsManifestYaml: args.currentAwsManifestYaml,
    currentIntegrationsManifestYaml: args.currentIntegrationsManifestYaml,
    brownfieldResourceScan: args.brownfieldResourceScan,
  });

  // Opus when authoring greenfield (T1 with empty manifest) per v2.5 §27.
  const isGreenfield = args.trigger === 'T1' && args.currentAwsManifestYaml.trim().length < 100;
  const defaultModel = isGreenfield ? 'opus' : 'sonnet';

  return {
    maxIterations: 2,
    agents: {
      ARCHITECT: buildAgentConfig({
        boilerplateKind: args.boilerplateKind,
        rigor: args.rigor,
        role: 'ARCHITECT',
        name: 'Architect',
        model: args.model || defaultModel,
      }),
    },
    steps: [
      {
        id: 'architect-resolve',
        agentId: 'ARCHITECT',
        prompt,
        extractors: {
          ARCHITECT_PROPOSAL_JSON: {
            type: 'between',
            startDelimiter: '---ARCHITECT_PROPOSAL---',
            endDelimiter: '---END_ARCHITECT_PROPOSAL---',
          },
        },
        validations: [],
      },
    ],
  };
}
