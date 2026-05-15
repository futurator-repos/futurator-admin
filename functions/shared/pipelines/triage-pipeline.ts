/**
 * triage-pipeline.ts — Pipeline v2 Phase 3 / Story 3-E-6-1 (PR-81).
 *
 * Single-step pipeline for TRIAGE. Output is a proposed bugfix plan that
 * the operator confirms via decision card; on confirm the existing plan
 * creation API surface (from Phase 1) takes the proposal and instantiates
 * a new plan.
 */

import type { PipelineDefinition } from '../types/agent-orchestrator';
import { buildTriagePrompt } from '../prompts/triage-prompt';
import type { BoilerplateType } from '../boilerplates/registry';
import type { PlanRigor } from '../types/plan';
import { buildAgentConfig } from './role-policy';
import { z } from 'zod';

export const TriageProposalSchema = z.object({
  feedbackId: z.string().min(1),
  projectSlug: z.string().min(1),
  planKind: z.enum(['bugfix', 'maintenance', 'change']),
  planTitle: z.string().min(1),
  planIntent: z.string().min(1),
  severity: z.enum(['low', 'medium', 'high', 'critical']),
  citedPriors: z.array(z.string()).default([]),
  confidence: z.number().min(0).max(1),
});
export type TriageProposal = z.infer<typeof TriageProposalSchema>;

export function validateTriageProposalBlock(
  raw: string,
): { ok: true; output: TriageProposal } | { ok: false; error: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    return { ok: false, error: `JSON parse failed: ${(e as Error).message}` };
  }
  const result = TriageProposalSchema.safeParse(parsed);
  if (!result.success) {
    const issue = result.error.issues[0];
    const path = issue?.path?.join('.') || '<root>';
    return { ok: false, error: `${path}: ${issue?.message ?? 'unknown shape error'}` };
  }
  return { ok: true, output: result.data };
}

export interface TriagePipelineArgs {
  feedback: {
    id: string;
    projectSlug: string;
    summary: string;
    severity: 'low' | 'medium' | 'high' | 'critical';
    reportedAt: string;
  };
  priors: Array<{
    caseId: string;
    project: string;
    summary: string;
    resolution: string;
    tier: 'same-project' | 'same-family' | 'cross-product';
    score: number;
  }>;
  boilerplateKind: BoilerplateType;
  rigor: PlanRigor;
  model?: string;
}

export function generateTriagePipeline(args: TriagePipelineArgs): PipelineDefinition {
  const prompt = buildTriagePrompt({ feedback: args.feedback, priors: args.priors });
  return {
    maxIterations: 2,
    agents: {
      TRIAGE: buildAgentConfig({
        boilerplateKind: args.boilerplateKind,
        rigor: args.rigor,
        role: 'TRIAGE',
        name: 'Triage',
        model: args.model || 'sonnet',
      }),
    },
    steps: [
      {
        id: 'triage-rank',
        agentId: 'TRIAGE',
        prompt,
        extractors: {
          TRIAGE_PROPOSAL_JSON: {
            type: 'between',
            startDelimiter: '---TRIAGE_PROPOSAL---',
            endDelimiter: '---END_TRIAGE_PROPOSAL---',
          },
        },
        validations: [],
      },
    ],
  };
}
