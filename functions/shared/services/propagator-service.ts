/**
 * propagator-service.ts — Seam B (Epic 6.5 activation): approve → enqueue.
 *
 * When an operator APPROVES a port-brief, this turns the proposal into a real
 * PENDING agent-job in the sibling's pipeline — but ONLY when that sibling is
 * registered (a `workingDir` + `pipeline` template). You cannot auto-port into a
 * repo you haven't wired, so an unregistered sibling approves-only (the decision
 * is recorded; the job is filed once the sibling is registered). This gate is
 * what keeps the enqueue real rather than speculative.
 *
 * Registration is config: `PROPAGATOR_SIBLING_PIPELINES` is a JSON map
 * `{ "<sibling>": { "workingDir": "/abs", "pipeline": { agents, steps } } }`.
 *
 * Pure builders unit-test directly; the route wires `crypto.randomUUID()` + the
 * clock + `agentJobsRepo.createJob`.
 */

import type { AgentJob, PipelineDefinition } from '../types/agent-orchestrator';
import type { PropagatorProposal } from '../types/propagator';

export interface SiblingPipelineConfig {
  workingDir: string;
  pipeline: PipelineDefinition;
}

/** Parse the sibling-pipeline registry from an env JSON string. Never throws. */
export function parseSiblingPipelines(
  raw: string | undefined,
): Record<string, SiblingPipelineConfig> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return {};
    const out: Record<string, SiblingPipelineConfig> = {};
    for (const [sibling, cfg] of Object.entries(parsed)) {
      const c = cfg as Partial<SiblingPipelineConfig>;
      if (c && typeof c.workingDir === 'string' && c.pipeline && Array.isArray(c.pipeline.steps)) {
        out[sibling] = { workingDir: c.workingDir, pipeline: c.pipeline };
      }
    }
    return out;
  } catch {
    return {};
  }
}

export type EnqueueDecision = { enqueue: true; job: AgentJob } | { enqueue: false; reason: string };

/**
 * Build the sibling port-story job for an approved proposal, or explain why it
 * can't be enqueued yet. Pure — `jobId`, `now`, `createdBy` are injected.
 *
 * The proposed story's title/epic + the justifying contract changes ride in as
 * `initialVariables`, and `PROPAGATOR_PROPOSAL_ID` links the job back to the
 * proposal so Seam C can advance the marker when it reaches Done.
 */
export function buildSiblingJob(
  proposal: PropagatorProposal,
  registry: Record<string, SiblingPipelineConfig>,
  ctx: { jobId: string; now: string; createdBy: string },
): EnqueueDecision {
  const cfg = registry[proposal.sibling];
  if (!cfg) {
    return { enqueue: false, reason: `sibling '${proposal.sibling}' not registered` };
  }

  const job: AgentJob = {
    jobId: ctx.jobId,
    status: 'PENDING',
    createdAt: ctx.now,
    updatedAt: ctx.now,
    createdBy: ctx.createdBy,
    workingDir: cfg.workingDir,
    projectId: proposal.sibling,
    pipeline: {
      ...cfg.pipeline,
      initialVariables: {
        ...(cfg.pipeline.initialVariables ?? {}),
        STORY_TITLE: proposal.proposedStory?.title ?? '',
        EPIC_ID: proposal.proposedStory?.epic ?? '',
        PROPAGATOR_PROPOSAL_ID: proposal.proposalId,
        PROPAGATOR_SOURCE: proposal.sourceProject,
        PROPAGATOR_BRIEF: proposal.brief,
        PROPAGATOR_CONTRACT_CHANGES: JSON.stringify(proposal.contractChanges ?? []),
      },
    },
  };
  return { enqueue: true, job };
}
