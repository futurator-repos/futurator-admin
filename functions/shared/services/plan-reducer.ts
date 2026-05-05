import type { EpicWorkflow, EpicStory } from '../types/epic-workflow';
import type { Plan } from '../types/plan';
import { reduceEpicWaves, type WaveReducerDeps } from './wave-reducer';
import { computePlanWaves, epicsInPlanWave, maxPlanWave } from './plan-waves';
import { launchPipelineWave, findFirstWave } from './pipeline-launcher';
import type { PipelineDefinition } from '../types/agent-orchestrator';
import {
  isTerminal as isJobStatusTerminal,
  isSuccess as isJobStatusSuccess,
} from '../types/agent-job-state-machine';

/**
 * Outer reducer — drives a Plan through its plan-wave state machine.
 *
 * Per tick:
 *   1. Run the inner reducer (reduceEpicWaves) on every epic under the plan.
 *   2. Check the current plan-wave: if all its epics are `completed`,
 *      launch plan-wave N+1 (kick off each epic's story-wave 0).
 *   3. When the last plan-wave completes, create a plan-build-check job.
 *   4. When plan-build-check completes, flip plan → `review`.
 *   5. If any epic goes to `fixing`, plan goes to `fixing` until operator
 *      recovers.
 *
 * This is pure + deps-injected for testability. The cron handler passes in
 * repository functions.
 */

export interface PlanReducerDeps extends WaveReducerDeps {
  updatePlanFields: (planId: string, patch: Partial<Plan>) => Promise<void>;
  /**
   * Pipeline builder for the plan-level final build-check. In production this
   * is `generatePlanBuildPipeline` from functions/shared/pipelines; in tests,
   * a stub.
   */
  generatePlanBuildPipeline: (workingDir: string, planName: string) => PipelineDefinition;
}

export type PlanReducerResult =
  | { kind: 'no-op'; reason: 'no-epics' | 'plan-terminal' | 'wave-running' }
  | { kind: 'plan-wave-launched'; waveNumber: number; epicIds: string[] }
  | { kind: 'plan-build-check-created'; jobId: string }
  | { kind: 'plan-build-check-pending' }
  | { kind: 'plan-completed' }
  | { kind: 'plan-fixing'; reason: 'epic-fixing' | 'build-check-failed' };

const TERMINAL_EPIC_STATUSES = new Set(['completed', 'fixing']);

function isEpicSuccessful(epic: EpicWorkflow): boolean {
  return epic.status === 'completed';
}

function anyEpicFixing(epics: EpicWorkflow[]): boolean {
  return epics.some((e) => e.status === 'fixing');
}

function epicLaunched(epic: EpicWorkflow): boolean {
  return epic.stories.some((s) => s.jobId);
}

// Story 1.1: classification delegated to `agent-job-state-machine`. Salvage
// (COMPLETED_VIA_SALVAGE) and Skip (MANUALLY_SKIPPED) count as success here
// — the operator's decision is taken as authoritative for plan-build-check
// completion just like it is for story-wave advancement.

export async function reducePlan(
  plan: Plan,
  epics: EpicWorkflow[],
  deps: PlanReducerDeps,
): Promise<PlanReducerResult> {
  if (epics.length === 0) {
    return { kind: 'no-op', reason: 'no-epics' };
  }
  if (plan.status !== 'developing' && plan.status !== 'fixing') {
    return { kind: 'no-op', reason: 'plan-terminal' };
  }

  // Phase C.3: cascade plan-level options into pipeline builders.
  const planOpts = {
    rigor: plan.rigor,
    testModel: plan.testModel,
    hasBrowserTests: plan.testingProfile?.hasBrowserTests,
  };

  // ── 1. Inner pass: advance each epic's internal story waves. ─────────
  for (const epic of epics) {
    try {
      await reduceEpicWaves(epic, deps, planOpts);
    } catch (err) {
      // Per-epic errors shouldn't block others. The inner cron (which calls
      // reduceEpicWaves directly too) also logs these.
      console.warn(`[PlanReducer] inner reducer failed for epic ${epic.epicId}: ${err}`);
    }
  }

  // PR-23c — roll up `doneStories` onto the plan row. The wave-reducer
  // flips story.status to 'done' but never propagates the rollup count
  // to the parent plan, so plan.doneStories stays at the value it had
  // when the plan was created (usually 0). The dashboard's "X/N stories"
  // counter is computed live from epic.stories so the UI looks correct,
  // but the persisted field — which the deploy panel and forensic
  // narrative read — is wrong. Counted across all epics each tick;
  // cheap (epics already in memory) and idempotent.
  // 2026-05-04 dino-runner-1 finished with 6/6 done in UI but
  // plan.doneStories: 0 in DDB. Fixed by this rollup.
  const doneStories = epics.reduce(
    (sum, e) => sum + (e.stories ?? []).filter((s) => s.status === 'done').length,
    0,
  );
  if (doneStories !== plan.doneStories) {
    try {
      await deps.updatePlanFields(plan.planId, { doneStories });
    } catch (err) {
      // Cosmetic field; never block the reducer on a write failure.
      console.warn(`[PlanReducer] doneStories rollup failed: ${err}`);
    }
  }

  // ── 2. Re-fetch epics to see post-inner state (or trust the passed-in
  //       ones — caller is responsible for providing fresh rows). For the
  //       cron we re-query below. ──

  // Guard: if any epic is fixing, plan goes to fixing.
  if (anyEpicFixing(epics)) {
    if (plan.status !== 'fixing') {
      await deps.updatePlanFields(plan.planId, { status: 'fixing' });
    }
    return { kind: 'plan-fixing', reason: 'epic-fixing' };
  }

  // ── 3. Compute plan-waves + find the current one. ────────────────────
  const planWaves = computePlanWaves(epics);
  const maxWave = maxPlanWave(planWaves);

  // Current plan-wave: the highest wave with any launched epic.
  const launchedEpics = epics.filter(epicLaunched);
  if (launchedEpics.length === 0) {
    // Plan was flipped to developing but no epic has launched yet.
    // /plans/:id/start should have launched plan-wave 0 — if it didn't, do it
    // now as a recovery. (Idempotent.)
    const firstWaveEpics = epicsInPlanWave(epics, planWaves, 0);
    const launchedIds: string[] = [];
    for (const epic of firstWaveEpics) {
      const result = await launchPipelineWave(
        epic,
        findFirstWave(epic),
        plan.createdBy,
        deps.now(),
        deps,
        planOpts,
      );
      if (result.ok) {
        launchedIds.push(epic.epicId);
        // Persist the story-wave launch on the epic row.
        await deps.updateEpicFields(epic.epicId, {
          stories: result.updatedStories,
          status: 'in_progress',
        });
      }
    }
    if (launchedIds.length > 0) {
      return { kind: 'plan-wave-launched', waveNumber: 0, epicIds: launchedIds };
    }
    return { kind: 'no-op', reason: 'wave-running' };
  }

  const currentPlanWave = Math.max(...launchedEpics.map((e) => planWaves[e.epicId] ?? 0));
  const currentPlanWaveEpics = epicsInPlanWave(epics, planWaves, currentPlanWave);

  // ── 4. Check if current plan-wave is fully done. ─────────────────────
  const allCurrentDone = currentPlanWaveEpics.every(isEpicSuccessful);
  if (!allCurrentDone) {
    // Wave still running — inner reducer handles per-epic progression.
    return { kind: 'no-op', reason: 'wave-running' };
  }

  // ── 5. Advance to plan-wave N+1 or run final build-check. ────────────
  const nextWave = currentPlanWave + 1;
  if (nextWave <= maxWave) {
    const nextWaveEpics = epicsInPlanWave(epics, planWaves, nextWave);
    // Only launch those that haven't launched yet (idempotent).
    const toLaunch = nextWaveEpics.filter((e) => !epicLaunched(e));
    if (toLaunch.length === 0) {
      return { kind: 'no-op', reason: 'wave-running' };
    }
    const launchedIds: string[] = [];
    for (const epic of toLaunch) {
      const result = await launchPipelineWave(
        epic,
        findFirstWave(epic),
        plan.createdBy,
        deps.now(),
        deps,
        planOpts,
      );
      if (result.ok) {
        launchedIds.push(epic.epicId);
        await deps.updateEpicFields(epic.epicId, {
          stories: result.updatedStories,
          status: 'in_progress',
        });
      }
    }
    return { kind: 'plan-wave-launched', waveNumber: nextWave, epicIds: launchedIds };
  }

  // ── 6. All plan-waves done. Handle final plan-build-check. ───────────
  //
  // PR-31b (2026-05-05) — for prototype rigor, skip plan-build-check entirely
  // and flip directly to `review`. Per-story `tsc --noEmit` + REVIEWER verdict
  // (and, for mvp/production rigor, wave-build-checks) already cover this.
  // The final integration check costs ~1-2min per plan and is one more place
  // a Next.js-flag bug can quietly fail. Mirrors PR-30 for wave-build-check.
  // mvp/production rigor still get the safety net.
  if (planOpts.rigor === 'prototype') {
    await deps.updatePlanFields(plan.planId, { status: 'review', reviewAt: deps.now() });
    return { kind: 'plan-completed' };
  }

  if (!plan.planBuildJobId) {
    // Create it.
    const jobId = deps.uuid();
    const now = deps.now();
    const pipeline = deps.generatePlanBuildPipeline(plan.workingDir, plan.name);
    await deps.createJob({
      jobId,
      status: 'PENDING',
      createdAt: now,
      updatedAt: now,
      createdBy: plan.createdBy,
      workingDir: plan.workingDir,
      pipeline,
    });
    await deps.updatePlanFields(plan.planId, { planBuildJobId: jobId });
    return { kind: 'plan-build-check-created', jobId };
  }

  // Build-check already exists — check its status.
  const buildJob = await deps.getJobById(plan.planBuildJobId);
  if (!buildJob || !isJobStatusTerminal(buildJob.status)) {
    // NEEDS_ATTENTION on the plan-build-check is also surfaced here as
    // "pending" — the plan stays in `developing` while the operator decides.
    return { kind: 'plan-build-check-pending' };
  }
  if (!isJobStatusSuccess(buildJob.status)) {
    if (plan.status !== 'fixing') {
      await deps.updatePlanFields(plan.planId, { status: 'fixing' });
    }
    return { kind: 'plan-fixing', reason: 'build-check-failed' };
  }

  // Build-check passed → plan complete.
  await deps.updatePlanFields(plan.planId, { status: 'review', reviewAt: deps.now() });
  return { kind: 'plan-completed' };
}

// Re-export for cron handler use.
export type { Plan, EpicStory };
export { TERMINAL_EPIC_STATUSES };
