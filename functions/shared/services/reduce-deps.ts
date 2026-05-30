/**
 * reduce-deps.ts — shared PlanReducerDeps factory (2026-05-30).
 *
 * The WaveCompletionCheck cron and the reactive
 * `POST /api/plans/:id/check-wave-completion` endpoint both run `reducePlan`
 * and need an identical dependency bundle. Extracted here so the two callers
 * can never drift (a past drift — the cron wiring the raw `createAttentionItem`
 * instead of the idempotent upsert — produced 54 duplicate attention rows for
 * one failure; see wave-completion-check.ts). One factory, one behavior.
 */

import crypto from 'node:crypto';
import * as agentJobsRepo from '../repositories/agent-jobs-repository';
import * as epicRepo from '../repositories/epic-workflow-repository';
import * as planRepo from '../repositories/plan-repository';
import * as attentionRepo from '../repositories/attention-items-repository';
import { generateStoryPipeline } from '../pipelines/story-pipeline';
import { generateWaveBuildPipeline } from '../pipelines/wave-build-pipeline';
import { generatePlanBuildPipeline } from '../pipelines/plan-build-pipeline';
import { type WaveReducerDeps } from './wave-reducer';
import { type PlanReducerDeps } from './plan-reducer';

/**
 * Build the wave-level reducer deps (job/epic IO + pipeline generators +
 * idempotent attention upsert).
 */
export function buildWaveReducerDeps(): WaveReducerDeps {
  return {
    getJobById: agentJobsRepo.getJobById,
    createJob: agentJobsRepo.createJob,
    updateEpicFields: epicRepo.updateEpicFields,
    generatePipeline: generateStoryPipeline,
    generateWaveBuildPipeline,
    uuid: () => crypto.randomUUID(),
    now: () => new Date().toISOString(),
    // dedupKey-bearing writes go through the idempotent upsert (matches the
    // daemon's writeAttentionItem path) so one logical failure = one row.
    writeAttentionItem: async (item) => {
      if (item.dedupKey) {
        await attentionRepo.upsertOpenAttentionItem({
          planId: item.planId,
          dedupKey: item.dedupKey,
          severity: item.severity,
          category: item.category,
          title: item.title,
          body: item.body,
          context: item.context,
          suggestedActions: item.suggestedActions,
        });
        return;
      }
      await attentionRepo.createAttentionItem(item);
    },
  };
}

/** Build the plan-level reducer deps (wave deps + plan IO + plan-build gen). */
export function buildPlanReducerDeps(): PlanReducerDeps {
  return {
    ...buildWaveReducerDeps(),
    updatePlanFields: planRepo.updatePlanFields,
    generatePlanBuildPipeline,
  };
}
