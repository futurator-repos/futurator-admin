/**
 * plan-spec-route — the ingest entry point handler (development-plan §5.1).
 *
 * Self-contained so the Hono app registers it in one line:
 *   app.post('/api/plans/:id/plan-spec', async (c) =>
 *     respond(c, await handlePlanSpecIngest({ planId: c.req.param('id'), body: await c.req.json() })));
 *
 * Used by the Concept driver on convergence AND as a manual/replay endpoint. The
 * repository is injected (defaults to the real story-node-repository) so the
 * handler unit-tests without DynamoDB.
 */

import {
  ingestPlanSpec,
  type StoryNodeRepository,
  type PlanStageRepository,
} from './plan-spec-ingest';
import { batchPutStoryNodes } from '../repositories/story-node-repository';

export interface PlanSpecIngestResponse {
  status: number;
  json: { ok: boolean; summary?: unknown; errors?: string[]; planId?: string };
}

/**
 * Handle a plan_spec ingest request. Maps the ingest result onto HTTP:
 *   • 200 — ingested (summary returned)
 *   • 422 — contract rejected (cycle / dangling / dup / bad shape) — the whole
 *           spec was refused, nothing written (errors returned)
 *   • 400 — body's planId doesn't match the route param (guard against mis-post)
 */
export async function handlePlanSpecIngest(args: {
  planId: string;
  body: unknown;
  repo?: StoryNodeRepository;
  planRepo?: PlanStageRepository;
}): Promise<PlanSpecIngestResponse> {
  const { planId, body } = args;
  const repo = args.repo ?? { batchPutStoryNodes };

  const bodyPlanId = (body as { planId?: string } | null)?.planId;
  if (bodyPlanId && planId && bodyPlanId !== planId) {
    return {
      status: 400,
      json: { ok: false, errors: [`planId mismatch: route ${planId} vs body ${bodyPlanId}`] },
    };
  }

  const result = await ingestPlanSpec(body, { repo, planRepo: args.planRepo });
  if (!result.ok) {
    return { status: 422, json: { ok: false, errors: result.errors } };
  }
  return { status: 200, json: { ok: true, planId, summary: result.summary } };
}
