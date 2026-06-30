/**
 * run-as-pipeline3-route — "Run as Pipeline-3" trigger handler (test bridge).
 *
 * Loads a legacy plan + its epics, converts to a plan_spec, and ingests it as
 * StoryNode rows — the one action that lets a UI-created plan flow through the
 * ready-frontier / story-dev path. Deps injected so it unit-tests without AWS.
 *
 * Wire in index.ts (one line):
 *   app.post('/api/plans/:id/run-as-pipeline-3', async (c) =>
 *     { const r = await handleRunAsPipeline3({ planId: c.req.param('id') }); return c.json(r.json, r.status); });
 */

import { convertPlanToPlanSpec } from './legacy-plan-to-plan-spec';
import { ingestPlanSpec, type StoryNodeRepository } from './plan-spec-ingest';
import { batchPutStoryNodes } from '../repositories/story-node-repository';
import type { Plan } from '../types/plan';
import type { EpicWorkflow } from '../types/epic-workflow';

export interface RunAsPipeline3Deps {
  getPlanById: (planId: string) => Promise<Plan | null>;
  getEpicById: (epicId: string) => Promise<EpicWorkflow | null>;
  repo?: StoryNodeRepository;
  now?: () => string;
}

export interface RunAsPipeline3Response {
  status: number;
  json: { ok: boolean; summary?: unknown; errors?: string[]; planId?: string; stories?: number };
}

export async function handleRunAsPipeline3(args: {
  planId: string;
  deps: RunAsPipeline3Deps;
}): Promise<RunAsPipeline3Response> {
  const { planId, deps } = args;
  const now = deps.now ?? (() => new Date().toISOString());

  const plan = await deps.getPlanById(planId);
  if (!plan) return { status: 404, json: { ok: false, errors: [`plan ${planId} not found`] } };

  const epics: EpicWorkflow[] = [];
  for (const epicId of plan.epicIds || []) {
    const epic = await deps.getEpicById(epicId);
    if (epic) epics.push(epic);
  }
  if (epics.length === 0) {
    return { status: 422, json: { ok: false, errors: ['plan has no epics to convert'] } };
  }

  const spec = convertPlanToPlanSpec(plan, epics, now());
  if (spec.stories.length === 0) {
    return { status: 422, json: { ok: false, errors: ['no runnable stories (all skipped?)'] } };
  }

  const repo = deps.repo ?? { batchPutStoryNodes };
  const result = await ingestPlanSpec(spec, { repo, now });
  if (!result.ok) {
    return { status: 422, json: { ok: false, errors: result.errors } };
  }
  return {
    status: 200,
    json: { ok: true, planId, stories: spec.stories.length, summary: result.summary },
  };
}
