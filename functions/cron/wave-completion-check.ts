import * as agentJobsRepo from '../shared/repositories/agent-jobs-repository';
import * as epicRepo from '../shared/repositories/epic-workflow-repository';
import * as planRepo from '../shared/repositories/plan-repository';
import * as attentionRepo from '../shared/repositories/attention-items-repository';
import { generateStoryPipeline } from '../shared/pipelines/story-pipeline';
import { generateWaveBuildPipeline } from '../shared/pipelines/wave-build-pipeline';
import { generatePlanBuildPipeline } from '../shared/pipelines/plan-build-pipeline';
import { type WaveReducerDeps } from '../shared/services/wave-reducer';
import { reducePlan, type PlanReducerDeps } from '../shared/services/plan-reducer';
import { launchVisualQa } from '../shared/services/visual-qa-launcher';
import { parseVisualTests, buildQaPipeline } from '../shared/pipelines/visual-qa-pipeline';
import { log } from '../shared/logger';
import type { EpicWorkflow } from '../shared/types/epic-workflow';

/**
 * Wave-completion cron — Story 16.2 + Story 17.4.
 *
 * Runs every minute. Processes two classes of work:
 *
 *  1. **Legacy epics (no planId)** — reduces each via the inner `reduceEpicWaves`
 *     (Story 16.2 behavior). Kept for backward compatibility; drops out once the
 *     last legacy epic is archived.
 *
 *  2. **Plans (status in {developing, fixing})** — reduces each via `reducePlan`
 *     which internally runs the inner reducer on each epic, then handles
 *     plan-wave advancement + final plan-build-check.
 *
 * Per-entity errors are caught + logged so one bad plan/epic doesn't block
 * others this tick.
 */
export const handler = async () => {
  const startedAt = Date.now();
  let epicsScanned = 0;
  let plansScanned = 0;
  let entitiesProcessed = 0;
  let errored = 0;
  const resultCounts: Record<string, number> = {};

  const waveDeps: WaveReducerDeps = {
    getJobById: agentJobsRepo.getJobById,
    createJob: agentJobsRepo.createJob,
    updateEpicFields: epicRepo.updateEpicFields,
    generatePipeline: generateStoryPipeline,
    generateWaveBuildPipeline,
    uuid: () => crypto.randomUUID(),
    now: () => new Date().toISOString(),
    writeAttentionItem: attentionRepo.createAttentionItem,
  };

  try {
    // ── 1. Plans pass — the authoritative entrypoint post-Story 17.4. ──
    const plans = await planRepo.getAllPlans();
    plansScanned = plans.length;
    const activePlans = plans.filter((p) => p.status === 'developing' || p.status === 'fixing');

    for (const plan of activePlans) {
      try {
        const epicsForPlan = [];
        for (const epicId of plan.epicIds) {
          const epic = await epicRepo.getEpicById(epicId);
          if (epic) epicsForPlan.push(epic);
        }
        if (epicsForPlan.length === 0) {
          log('warn', 'wave-completion-check', 'plan has epicIds but no epics resolved', {
            planId: plan.planId,
          });
          continue;
        }

        const planDeps: PlanReducerDeps = {
          ...waveDeps,
          updatePlanFields: planRepo.updatePlanFields,
          generatePlanBuildPipeline,
        };

        const result = await reducePlan(plan, epicsForPlan, planDeps);
        entitiesProcessed++;
        resultCounts[`plan:${result.kind}`] = (resultCounts[`plan:${result.kind}`] || 0) + 1;
        log('info', 'wave-completion-check', 'reduced plan', {
          planId: plan.planId,
          name: plan.name,
          result,
        });

        // QA auto-enqueue: when the plan just flipped to `review` AND
        // `autoRunQa` is enabled, kick off Visual QA for every epic that has
        // visual tests but no QA job yet. Manual re-runs remain available via
        // POST /api/plans/:id/qa-review.
        if (result.kind === 'plan-completed' && plan.autoRunQa) {
          for (const epic of epicsForPlan) {
            if (epic.qaJobId) continue; // already has a run
            try {
              const now = new Date().toISOString();
              const qaResult = await launchVisualQa(epic, plan.createdBy, now, {
                getJobById: agentJobsRepo.getJobById,
                createJob: agentJobsRepo.createJob,
                parseVisualTests,
                buildQaPipeline,
                uuid: () => crypto.randomUUID(),
              });
              if (qaResult.ok) {
                const patch: Partial<EpicWorkflow> = { qaJobId: qaResult.jobId };
                if (qaResult.storiesChanged) patch.stories = qaResult.updatedStories;
                await epicRepo.updateEpicFields(epic.epicId, patch);
                log('info', 'wave-completion-check', 'auto-enqueued QA', {
                  planId: plan.planId,
                  epicId: epic.epicId,
                  jobId: qaResult.jobId,
                });
              } else {
                log('info', 'wave-completion-check', 'auto-QA skipped', {
                  planId: plan.planId,
                  epicId: epic.epicId,
                  reason: qaResult.message,
                });
              }
            } catch (err) {
              log('error', 'wave-completion-check', 'auto-QA enqueue failed', {
                planId: plan.planId,
                epicId: epic.epicId,
                error: err instanceof Error ? err.message : String(err),
              });
            }
          }
        }
      } catch (err) {
        errored++;
        log('error', 'wave-completion-check', 'per-plan failure', {
          planId: plan.planId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    // ── 2. Legacy epic pass — only for epics NOT linked to a plan. ──
    // Once Epic 17.8 retires orchestrator + activeAppName, every epic will
    // have a planId and this pass becomes a no-op (safe to delete then).
    const epics = await epicRepo.getAllEpics();
    epicsScanned = epics.length;
    const legacyActive = epics.filter(
      (e) => !e.planId && e.useEpicOrchestrator === false && e.status === 'in_progress',
    );
    // Legacy pass disabled post-17.4 — plans own epic reduction via reducePlan.
    // Kept here for observability + to be uncommented if an orphan legacy epic
    // ever needs manual reduction.
    void legacyActive;

    log('info', 'wave-completion-check', 'tick complete', {
      epicsScanned,
      plansScanned,
      activePlans: activePlans.length,
      entitiesProcessed,
      errored,
      resultCounts,
      elapsedMs: Date.now() - startedAt,
    });
  } catch (err) {
    log('error', 'wave-completion-check', 'top-level failure', {
      error: err instanceof Error ? err.message : String(err),
      epicsScanned,
      plansScanned,
    });
  }
};
