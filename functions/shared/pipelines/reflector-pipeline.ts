/**
 * reflector-pipeline.ts — Pipeline v2 Phase 3 / Story 3-E-2-1.
 *
 * Single-step pipeline for REFLECTOR. Reads the project's CLAUDE.md +
 * existing reflections inbox + new-commits window; emits structured
 * proposals between markers. The daemon runner (reflector-runner.mjs)
 * is the parse + apply side.
 *
 * Per v2.5 §38: REFLECTOR is **strictly propose-only** — Write / Edit /
 * NotebookEdit / Bash denied at the CLI layer (RolePolicy carries this).
 * Git read verbs come from `@futurator/mcp-git-readonly` (Story 3-C-9);
 * the pre-rendered git log slice flows through the prompt's `newGitLog`
 * field. Until 3-C-9 lands, the daemon runner can render the slice
 * directly via a one-shot `git log` from outside the agent context.
 */

import type { PipelineDefinition } from '../types/agent-orchestrator';
import { buildReflectorPrompt, type ReflectorScope } from '../prompts/reflector-prompt';
import type { BoilerplateType } from '../boilerplates/registry';
import type { PlanRigor } from '../types/plan';
import { buildAgentConfig } from './role-policy';
import { z } from 'zod';

/**
 * Zod schema for a single REFLECTOR proposal. The wrap-it-target case
 * carries additional fields (recurrences, failure-rate, score, pattern,
 * proposed-name) per v2.5 §38.4; we keep them optional on the base shape
 * so the runner can branch on `target` rather than requiring six schemas.
 */
export const ReflectionProposalSchema = z.object({
  target: z.enum([
    'project-claude-md',
    'project-skill',
    'agent-persona',
    'org-skill',
    'pipeline-config',
    'tool-wrapper',
  ]),
  action: z.enum([
    'append-section',
    'replace-section',
    'append-line',
    'create',
    'promote-from-project',
    'tune',
    'propose',
  ]),
  section: z.string().optional(),
  skillName: z.string().optional(),
  personaName: z.string().optional(),
  content: z.string().min(1),
  rationale: z.string().min(1),
  evidence: z.array(z.string()).default([]),
  confidence: z.number().min(0).max(1),
});
export type ReflectionProposal = z.infer<typeof ReflectionProposalSchema>;

export const ReflectorOutputSchema = z.object({
  planId: z.string().min(1),
  scope: z.enum(['story', 'wave', 'plan', 'brownfield-cycle']),
  summary: z.string().min(1),
  proposals: z.array(ReflectionProposalSchema),
});
export type ReflectorOutput = z.infer<typeof ReflectorOutputSchema>;

export function validateReflectionsBlock(
  raw: string,
): { ok: true; output: ReflectorOutput } | { ok: false; error: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    return { ok: false, error: `JSON parse failed: ${(e as Error).message}` };
  }
  const result = ReflectorOutputSchema.safeParse(parsed);
  if (!result.success) {
    const issue = result.error.issues[0];
    const path = issue?.path?.join('.') || '<root>';
    return { ok: false, error: `${path}: ${issue?.message ?? 'unknown shape error'}` };
  }
  return { ok: true, output: result.data };
}

export interface ReflectorPipelineArgs {
  scope: ReflectorScope;
  planId: string;
  projectSlug: string;
  /** Boilerplate kind — drives RolePolicy turn cap resolution. */
  boilerplateKind: BoilerplateType;
  rigor: PlanRigor;
  /** Inbox frontmatter cursor for the diff-only window. */
  lastSeenSha: string | null;
  lastReflectionAt: string | null;
  /** Pre-rendered git log slice (runner produces this). */
  newGitLog: string;
  /** Current project CLAUDE.md (or empty string). */
  projectClaudeMd: string;
  /** Current reflections inbox content (or empty string). */
  existingInbox: string;
  /** Override model — Sonnet default. */
  model?: string;
}

export function generateReflectorPipeline(args: ReflectorPipelineArgs): PipelineDefinition {
  const prompt = buildReflectorPrompt({
    scope: args.scope,
    planId: args.planId,
    projectSlug: args.projectSlug,
    lastSeenSha: args.lastSeenSha,
    lastReflectionAt: args.lastReflectionAt,
    newGitLog: args.newGitLog,
    projectClaudeMd: args.projectClaudeMd,
    existingInbox: args.existingInbox,
  });

  return {
    maxIterations: 2,
    agents: {
      REFLECTOR: buildAgentConfig({
        boilerplateKind: args.boilerplateKind,
        rigor: args.rigor,
        role: 'REFLECTOR',
        name: 'Reflector',
        model: args.model || 'sonnet',
      }),
    },
    steps: [
      {
        id: 'reflector-observe',
        agentId: 'REFLECTOR',
        prompt,
        extractors: {
          REFLECTION_JSON: {
            type: 'between',
            startDelimiter: '---REFLECTION---',
            endDelimiter: '---END_REFLECTION---',
          },
        },
        validations: [],
      },
    ],
  };
}
