import * as agentJobsRepo from '../shared/repositories/agent-jobs-repository';
import * as epicRepo from '../shared/repositories/epic-workflow-repository';
import * as planRepo from '../shared/repositories/plan-repository';
import * as appRepo from '../shared/repositories/app-repository';
import { resolveQaContext } from '../shared/services/qa-boilerplate-resolver';
// Story 1.8.7 — 3× escalator: fire-and-forget after plan is marked delivered
import { evaluateThresholds } from '../shared/timer/escalator';
import { reducePlan, type PlanReducerDeps } from '../shared/services/plan-reducer';
import { driveConcept, type ConceptDriverDeps } from '../shared/services/concept-driver';
// 2026-05-30 — shared reducer-deps factory (cron + reactive endpoint parity).
import { buildPlanReducerDeps } from '../shared/services/reduce-deps';
import { launchPlanQaAggregate, launchPlanQaExecute } from '../shared/services/visual-qa-launcher';
import {
  parseVisualTests,
  buildQaAggregatePipeline,
  buildQaExecutePipeline,
} from '../shared/pipelines/visual-qa-pipeline';
import { log } from '../shared/logger';
// Deployment v2.5 — auto-publish the green build to the dev preview on review.
import { resolveDeployTarget } from '../shared/deploy/deploy-targets';
import { buildDeployJob } from '../shared/deploy/build-deploy-pipeline';

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

  // 2026-05-30 — deps now come from the shared factory (buildPlanReducerDeps)
  // so the cron and the reactive POST /api/plans/:id/check-wave-completion
  // endpoint can never drift. (The factory preserves the 2026-05-18 dino1 fix
  // routing dedupKey writes through the idempotent upsert.)
  const planDepsShared: PlanReducerDeps = buildPlanReducerDeps();

  try {
    // ── 1. Plans pass — the authoritative entrypoint post-Story 17.4. ──
    const plans = await planRepo.getAllPlans();
    plansScanned = plans.length;
    const activePlans = plans.filter(
      (p) => p.status === 'developing' || p.status === 'fixing' || p.status === 'review',
    );

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

        // 2026-05-30 — acquire the per-plan reduce lock so the cron and the
        // reactive endpoint never run reducePlan concurrently for one plan
        // (which could double-create a wave-merge/next-wave job). If a reactive
        // call holds it, skip this plan — it's being handled; we'll catch any
        // residual next tick. The QA-enqueue below is separately idempotent
        // (guarded by qaJobId/qaAggregateJobId) so it stays outside the lock.
        const reduceToken = await planRepo.acquirePlanReduceLock(plan.planId, Date.now());
        if (!reduceToken) {
          resultCounts['plan:reduce-locked'] = (resultCounts['plan:reduce-locked'] || 0) + 1;
          continue;
        }
        let result;
        try {
          result = await reducePlan(plan, epicsForPlan, planDepsShared);
        } finally {
          await planRepo.releasePlanReduceLock(plan.planId, reduceToken);
        }
        entitiesProcessed++;
        resultCounts[`plan:${result.kind}`] = (resultCounts[`plan:${result.kind}`] || 0) + 1;
        log('info', 'wave-completion-check', 'reduced plan', {
          planId: plan.planId,
          name: plan.name,
          result,
        });

        // Pipeline v2.0 PR-8d — auto-enqueue the QA AGGREGATE stage. When
        // the plan flips to `review` AND `autoRunQa` is enabled AND
        // there's no aggregate or execute QA job yet, launch the aggregate
        // stage. The execute stage runs after the operator approves the
        // contract via POST /api/plans/:id/qa-contract/approve.
        //
        // PR-8a's plan-scoping is preserved: ONE aggregate per plan,
        // never per-epic. PR-8a's `launchPlanVisualQa` (single-stage) is
        // still exported for callers that don't want the contract gate;
        // the cron now uses `launchPlanQaAggregate` instead.
        // dino1 (2026-06-10) — auto-QA is now DEFAULT-ON for every rigor
        // (`!== false` instead of truthy). Pre-fix `plan.autoRunQa` was
        // undefined below production rigor, so QA never ran without the
        // operator clicking "Run QA Review" on every single plan.
        if (
          result.kind === 'plan-completed' &&
          plan.autoRunQa !== false &&
          !plan.qaJobId &&
          !plan.qaAggregateJobId
        ) {
          try {
            const now = new Date().toISOString();
            // PR-8g — auto-enqueue uses the App's boilerplate qaContext too.
            const boilerplate = await resolveQaContext(plan, { getApp: appRepo.getApp });
            const qaResult = await launchPlanQaAggregate(
              plan,
              epicsForPlan,
              plan.createdBy,
              now,
              {
                getJobById: agentJobsRepo.getJobById,
                createJob: agentJobsRepo.createJob,
                parseVisualTests,
                buildQaAggregatePipeline,
                buildQaExecutePipeline,
                uuid: () => crypto.randomUUID(),
              },
              { boilerplate },
            );
            if (qaResult.ok) {
              // Persist aggregate job + transition contract status to
              // `pending` — operator review gate now active.
              await planRepo.updatePlanFields(plan.planId, {
                qaAggregateJobId: qaResult.jobId,
                qaContractStatus: 'pending',
              });
              for (const [epicId, stories] of qaResult.updatedStoriesByEpic) {
                await epicRepo.updateEpicFields(epicId, { stories });
              }
              log('info', 'wave-completion-check', 'auto-enqueued QA aggregate stage', {
                planId: plan.planId,
                jobId: qaResult.jobId,
                testCount: qaResult.testCount,
                epicCount: epicsForPlan.length,
              });
            } else {
              log('info', 'wave-completion-check', 'auto-QA aggregate skipped', {
                planId: plan.planId,
                reason: qaResult.message,
              });
            }
          } catch (err) {
            log('error', 'wave-completion-check', 'auto-QA aggregate enqueue failed', {
              planId: plan.planId,
              error: err instanceof Error ? err.message : String(err),
            });
          }
        }

        // dino1 (2026-06-10) — close the second manual gap: auto-approve the
        // QA contract. Pre-fix, even with the aggregate auto-enqueued the
        // EXECUTE stage waited for the operator to click "Approve N tests" on
        // every plan. With auto-QA on (default), once the aggregate job
        // completes we launch execute with the classified tests as-is;
        // classification warnings stay visible in the QA view for post-hoc
        // review, and the operator can still edit+approve manually before the
        // next tick wins the race (both paths are guarded by qaJobId).
        if (
          plan.autoRunQa !== false &&
          plan.qaContractStatus === 'pending' &&
          plan.qaAggregateJobId &&
          !plan.qaJobId
        ) {
          try {
            const aggJob = await agentJobsRepo.getJobById(plan.qaAggregateJobId);
            if (aggJob?.status === 'COMPLETED') {
              type FlatTest = import('../shared/types/epic-workflow').VisualTestDef & {
                storyId: string;
                storyTitle: string;
                epicId?: string;
                epicTitle?: string;
              };
              const flatTests: FlatTest[] = [];
              for (const epic of epicsForPlan) {
                for (const story of epic.stories) {
                  for (const vt of story.visualTests ?? []) {
                    flatTests.push({
                      ...vt,
                      storyId: story.storyId,
                      storyTitle: story.title,
                      epicId: epic.epicId,
                      epicTitle: epic.title,
                    });
                  }
                }
              }
              if (flatTests.length > 0) {
                const now = new Date().toISOString();
                const boilerplate = await resolveQaContext(plan, { getApp: appRepo.getApp });
                const execResult = await launchPlanQaExecute(
                  plan,
                  flatTests,
                  plan.createdBy,
                  now,
                  {
                    getJobById: agentJobsRepo.getJobById,
                    createJob: agentJobsRepo.createJob,
                    parseVisualTests,
                    buildQaAggregatePipeline,
                    buildQaExecutePipeline,
                    uuid: () => crypto.randomUUID(),
                  },
                  { boilerplate },
                );
                if (execResult.ok) {
                  await planRepo.updatePlanFields(plan.planId, {
                    qaJobId: execResult.jobId,
                    qaContractStatus: 'approved',
                    qaContractDecidedAt: now,
                    qaContractDecidedBy: 'auto:wave-completion-check',
                  });
                  log('info', 'wave-completion-check', 'auto-approved QA contract', {
                    planId: plan.planId,
                    jobId: execResult.jobId,
                    testCount: execResult.testCount,
                  });
                } else {
                  log('warn', 'wave-completion-check', 'auto-approve QA execute launch failed', {
                    planId: plan.planId,
                    reason: execResult.message,
                  });
                }
              }
            }
          } catch (err) {
            log('error', 'wave-completion-check', 'auto-approve QA contract failed', {
              planId: plan.planId,
              error: err instanceof Error ? err.message : String(err),
            });
          }
        }

        // Deploy-completion detection: when plan is in `review` and its
        // latest deploy job transitioned to COMPLETED, flip plan status to
        // `delivered` so the Published pipeline dot lights up. If the job
        // FAILED, the plan stays in `review` (operator can retry from the
        // Deploy stage's release strip).
        if (plan.status === 'review') {
          // Deployment v2.5 — auto-publish the green build to the DEV preview
          // so the operator can click exactly what headless QA tests against.
          // Fires AT MOST ONCE per plan (guarded by plan.devDeployJobId);
          // re-deploys are manual from the QA stage. Non-production, so the
          // daemon's writeback records a preview URL and never advances main.
          // Never blocks delivery — wrapped in its own try/catch.
          if (!plan.devDeployJobId) {
            try {
              const deployEpic = epicsForPlan
                .slice()
                .sort((a, b) => (b.epicWave ?? 0) - (a.epicWave ?? 0))[0];
              const appName = deployEpic.workingDir.split('/').filter(Boolean).pop() || plan.name;
              const target = resolveDeployTarget(appName, 'dev');
              const devJobId = planDepsShared.uuid();
              await planDepsShared.createJob(
                buildDeployJob({
                  jobId: devJobId,
                  epicId: deployEpic.epicId,
                  workingDir: deployEpic.workingDir,
                  createdBy: plan.createdBy,
                  nowIso: planDepsShared.now(),
                  target,
                }),
              );
              await planRepo.updatePlanFields(plan.planId, { devDeployJobId: devJobId });
              log('info', 'wave-completion-check', 'auto dev-deploy enqueued', {
                planId: plan.planId,
                jobId: devJobId,
                url: target.publicUrl,
              });
            } catch (err) {
              log('error', 'wave-completion-check', 'auto dev-deploy failed (non-fatal)', {
                planId: plan.planId,
                error: err instanceof Error ? err.message : String(err),
              });
            }
          }

          const latestDeployJobId =
            plan.deployJobIds?.[plan.deployJobIds.length - 1] ??
            epicsForPlan.slice().sort((a, b) => (b.epicWave ?? 0) - (a.epicWave ?? 0))[0]
              ?.deployJobId;
          if (latestDeployJobId) {
            const deployJob = await agentJobsRepo.getJobById(latestDeployJobId);
            if (deployJob?.status === 'COMPLETED') {
              const deployUrl = deployJob.variables?.DEPLOY_URL;
              await planRepo.updatePlanFields(plan.planId, {
                status: 'delivered',
                deployUrl,
              });
              log('info', 'wave-completion-check', 'plan marked delivered', {
                planId: plan.planId,
                deployJobId: latestDeployJobId,
                deployUrl,
              });
              // Story 1.8.7 — 3× escalator: compare timing vs cohort baseline.
              // Fire-and-forget — never block the terminal write on this.
              void evaluateThresholds(plan.planId).catch((err: unknown) => {
                log('error', 'wave-completion-check', 'escalator failed (non-fatal)', {
                  planId: plan.planId,
                  error: err instanceof Error ? err.message : String(err),
                });
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

    // ── 1b. Concept pass (E3.2) — advance the spec-development DAG. ──
    // The active-plans filter above is intentionally scoped to {developing,
    // fixing, review}; concept-stage plans need their own pass or the chain
    // never advances unattended. Gate on `conceptPlan` presence so the hot loop
    // stays off prototype/legacy plans (no chain). Each plan is driven under the
    // same per-plan reduce lock the reactive apply endpoint uses — exactly one
    // next job is created.
    const conceptPlans = plans.filter((p) => p.status === 'concept' && p.conceptPlan);
    if (conceptPlans.length > 0) {
      const conceptDeps: ConceptDriverDeps = {
        getPlanById: planRepo.getPlanById,
        getJobById: agentJobsRepo.getJobById,
        createJob: agentJobsRepo.createJob,
        updatePlanFields: planRepo.updatePlanFields,
        getApp: appRepo.getApp,
        uuid: () => crypto.randomUUID(),
        now: () => new Date().toISOString(),
      };
      for (const plan of conceptPlans) {
        const token = await planRepo.acquirePlanReduceLock(plan.planId, Date.now());
        if (!token) {
          resultCounts['concept:reduce-locked'] = (resultCounts['concept:reduce-locked'] || 0) + 1;
          continue;
        }
        try {
          const driveResult = await driveConcept(plan, conceptDeps);
          resultCounts[`concept:${driveResult.kind}`] =
            (resultCounts[`concept:${driveResult.kind}`] || 0) + 1;
          if (driveResult.kind !== 'noop') {
            log('info', 'wave-completion-check', 'drove concept plan', {
              planId: plan.planId,
              result: driveResult,
            });
          }
        } catch (err) {
          errored++;
          log('error', 'wave-completion-check', 'per-plan concept-drive failure', {
            planId: plan.planId,
            error: err instanceof Error ? err.message : String(err),
          });
        } finally {
          await planRepo.releasePlanReduceLock(plan.planId, token);
        }
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
