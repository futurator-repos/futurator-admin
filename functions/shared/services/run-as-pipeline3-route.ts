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
  json: {
    ok: boolean;
    summary?: unknown;
    errors?: string[];
    // `error` (singular) mirrors the joined `errors` so the api-client surfaces
    // the real reason instead of a generic "Request failed".
    error?: string;
    planId?: string;
    stories?: number;
  };
}

/** Shape a rejection so BOTH `errors[]` (tests) and `error` (api-client) carry it. */
function reject(status: number, errors: string[]): RunAsPipeline3Response {
  return { status, json: { ok: false, errors, error: errors.join('; ') } };
}

export async function handleRunAsPipeline3(args: {
  planId: string;
  deps: RunAsPipeline3Deps;
}): Promise<RunAsPipeline3Response> {
  const { planId, deps } = args;
  const now = deps.now ?? (() => new Date().toISOString());

  const plan = await deps.getPlanById(planId);
  if (!plan) return reject(404, [`plan ${planId} not found`]);

  const epics: EpicWorkflow[] = [];
  for (const epicId of plan.epicIds || []) {
    const epic = await deps.getEpicById(epicId);
    if (epic) epics.push(epic);
  }
  if (epics.length === 0) {
    return reject(422, [
      `Plan is still in "${plan.status}" — no epics to convert yet. Let the concept chain finish (it produces the epic/story breakdown), then run this again.`,
    ]);
  }

  const spec = convertPlanToPlanSpec(plan, epics, now());
  if (spec.stories.length === 0) {
    return reject(422, ['no runnable stories (all skipped?)']);
  }

  const repo = deps.repo ?? { batchPutStoryNodes };
  const result = await ingestPlanSpec(spec, { repo, now });
  if (!result.ok) {
    return reject(422, result.errors || ['ingest rejected the converted spec']);
  }
  return {
    status: 200,
    json: { ok: true, planId, stories: spec.stories.length, summary: result.summary },
  };
}
