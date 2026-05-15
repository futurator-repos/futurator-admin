/**
 * skill-scout-pipeline.ts — Pipeline v2 Phase 3 / Story 3-C-3-1.
 *
 * Single-step pipeline definition for the SKILL-SCOUT agent. The agent
 * reads the project's current skill manifest + federation sources and
 * emits a `SkillProposal[]` between markers. The pipeline runner captures
 * the block via the `between` extractor; downstream the daemon's skill-
 * installer (PR-72 follow-on, Story 3-C-3-2) applies operator-confirmed
 * proposals to `.claude/skills.manifest.yaml`.
 *
 * Three triggers wire to this same pipeline shape (3-C-3-2 implements the
 * wiring). The `trigger` field on the prompt args + extractor output lets
 * the daemon route the resulting card differently (auto-confirm under
 * prototype if T1/T2, surface card otherwise, never auto-confirm T3).
 *
 * Model selection per PR-72:
 *   - Sonnet by default
 *   - Opus when SKILL-SCOUT must author a missing skill (Story 3-C-7 sub-
 *     plan path). The pipeline definition itself accepts an explicit model
 *     override — the caller picks the right one.
 */

import type { PipelineDefinition } from '../types/agent-orchestrator';
import { buildSkillScoutPrompt, type SkillScoutTrigger } from '../prompts/skill-scout-prompt';
import type { BoilerplateType } from '../boilerplates/registry';
import type { PlanRigor } from '../types/plan';
import { buildAgentConfig } from './role-policy';
import { z } from 'zod';

/**
 * Zod schema for a single skill proposal in SKILL-SCOUT's between-marker
 * output. Used by `validateSkillProposalsBlock()` to shape-check before
 * the daemon writes anything.
 */
export const SkillProposalSchema = z.object({
  kind: z.enum(['add', 'remove', 'upgrade']),
  source: z.string().min(1),
  skill: z.string().min(1),
  manifestBucket: z.enum(['core', 'stack', 'domain', 'vendor']),
  version: z.string().regex(/^(sha:[a-f0-9]{40}|tag:[A-Za-z0-9.+\-_]+)$/, {
    message: 'version must match sha:<40-char-hex> or tag:<version>',
  }),
  rationale: z.string().min(1),
  verifyNotes: z.string().min(1),
  confidence: z.number().min(0).max(1),
});
export type SkillProposal = z.infer<typeof SkillProposalSchema>;

export const SkillScoutOutputSchema = z.object({
  // PR-79 (Story 3-C-5) — extended from T1/T2/T3 to the full eight
  // triggers per v2.5 §38 (PM speculation, new dep, REVIEWER repeats,
  // stream graduates, weekly refresh).
  trigger: z.enum(['T1', 'T2', 'T3', 'T4', 'T5', 'T6', 'T7', 'T8']),
  projectSlug: z.string().min(1),
  proposals: z.array(SkillProposalSchema),
});
export type SkillScoutOutput = z.infer<typeof SkillScoutOutputSchema>;

/**
 * Parse SKILL-SCOUT's between-marker output. Returns `{ ok, output }` on
 * success or `{ ok: false, error }` with a human-readable Zod-error path.
 * The daemon's run loop uses this to decide whether to surface the card
 * or emit `attention.skill-scout-output-invalid`.
 */
export function validateSkillProposalsBlock(
  raw: string,
): { ok: true; output: SkillScoutOutput } | { ok: false; error: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    return { ok: false, error: `JSON parse failed: ${(e as Error).message}` };
  }
  const result = SkillScoutOutputSchema.safeParse(parsed);
  if (!result.success) {
    const issue = result.error.issues[0];
    const path = issue?.path?.join('.') || '<root>';
    return { ok: false, error: `${path}: ${issue?.message ?? 'unknown shape error'}` };
  }
  return { ok: true, output: result.data };
}

export interface SkillScoutPipelineArgs {
  /** Which trigger is firing — drives the prompt's per-trigger guidance. */
  trigger: SkillScoutTrigger;
  /** Project slug (App.appId). */
  projectSlug: string;
  /** Plan intent text — required for T2; absent for T1/T3. */
  planIntent?: string;
  /** Boilerplate kind from registry; resolver consults pmContext defaults. */
  boilerplateKind: BoilerplateType;
  /** Plan rigor — drives turn cap from RolePolicy. */
  rigor: PlanRigor;
  /** Current project manifest serialized as YAML (for SCOUT to read). */
  currentManifestYaml: string;
  /** Federation sources serialized as YAML (read-only context). */
  federationYaml: string;
  /** Override model — Sonnet default; Opus when authoring (PR-72). */
  model?: string;
}

/**
 * Build the SKILL-SCOUT pipeline definition. Mirrors `generatePmPlanPipeline`
 * shape — single agent, single step, `between` extractor for the proposal
 * block.
 */
export function generateSkillScoutPipeline(args: SkillScoutPipelineArgs): PipelineDefinition {
  const prompt = buildSkillScoutPrompt({
    trigger: args.trigger,
    projectSlug: args.projectSlug,
    planIntent: args.planIntent,
    boilerplateKind: args.boilerplateKind,
    currentManifestYaml: args.currentManifestYaml,
    federationYaml: args.federationYaml,
  });

  return {
    maxIterations: 2,
    agents: {
      SKILL_SCOUT: buildAgentConfig({
        boilerplateKind: args.boilerplateKind,
        rigor: args.rigor,
        role: 'SKILL_SCOUT',
        name: 'Skill Scout',
        model: args.model || 'sonnet',
      }),
    },
    steps: [
      {
        id: 'skill-scout-resolve',
        agentId: 'SKILL_SCOUT',
        prompt,
        extractors: {
          SKILL_PROPOSALS_JSON: {
            type: 'between',
            startDelimiter: '---SKILL_PROPOSALS---',
            endDelimiter: '---END_SKILL_PROPOSALS---',
          },
        },
        validations: [],
      },
    ],
  };
}
