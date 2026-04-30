import type { AgentJob, PipelineDefinition } from '../types/agent-orchestrator';
import {
  isTerminal as isJobStatusTerminal,
  isSuccess as isJobStatusSuccess,
  isPaused as isJobStatusPaused,
} from '../types/agent-job-state-machine';
import type { EpicStory, EpicWorkflow } from '../types/epic-workflow';
import type { AttentionItem } from '../types/attention';
import {
  launchPipelineWave,
  type PipelineLauncherDeps,
  type PlanExecutionOpts,
} from './pipeline-launcher';

/**
 * Wave-completion reducer — Story 16.2.
 *
 * Drives a Pipeline-mode epic through its wave state machine:
 *
 *   wave N stories enqueued → wait for all jobs terminal
 *   → any failed? epic.status = 'fixing', halt
 *   → all completed? create wave-build-check (idempotent via waveBuildJobs[N])
 *     → build-check running? wait
 *     → build-check failed? epic.status = 'fixing', halt
 *     → build-check completed? launch wave N+1, or mark epic completed
 *
 * Called once per epic per cron firing. Reducer is pure + deps-injected so it
 * is trivially unit-testable (see `__tests__/wave-reducer.test.ts`).
 */

// ── Terminal status helpers ────────────────────────────────────────────────
//
// Authoritative classification lives in `agent-job-state-machine.ts` as of
// Pipeline v1 / Story 1.1. Local aliases keep the call sites in this file
// readable; do not redefine these sets inline.

const isTerminal = isJobStatusTerminal;
const isSuccess = isJobStatusSuccess;
const isPaused = isJobStatusPaused;

// ── Deps + result types ────────────────────────────────────────────────────

export interface WaveReducerDeps extends PipelineLauncherDeps {
  getJobById: (jobId: string) => Promise<AgentJob | null>;
  updateEpicFields: (epicId: string, patch: Partial<EpicWorkflow>) => Promise<void>;
  /**
   * Wave build-check pipeline builder. In production this is the
   * `generateWaveBuildPipeline` helper in functions/api/index.ts; in tests
   * a stub.
   */
  generateWaveBuildPipeline: (
    workingDir: string,
    waveNumber: number,
    storyTitles: string[],
  ) => PipelineDefinition;
  now: () => string;
  /**
   * Pipeline Enhancement Plan v2 — Phase B.4. Optional writer used by the
   * reducer to synthesize attention items when waves or wave-build-checks
   * fail. No-op when undefined (tests can omit). Daemon also writes inline
   * items (Phase A.5); UI dedupes duplicates.
   */
  writeAttentionItem?: (item: AttentionItem) => Promise<void>;
  uuid: () => string;
}

export type WaveReducerResult =
  | {
      kind: 'no-op';
      reason: 'no-stories' | 'wave-running' | 'all-waves-done' | 'epic-fixing' | 'no-current-wave';
    }
  | { kind: 'story-statuses-synced'; waveNumber: number }
  | { kind: 'wave-paused'; waveNumber: number; needsAttentionStoryIds: string[] }
  | { kind: 'wave-failed'; waveNumber: number; failedStoryIds: string[] }
  | { kind: 'wave-build-check-created'; waveNumber: number; jobId: string }
  | { kind: 'wave-build-check-pending'; waveNumber: number }
  | { kind: 'wave-build-check-failed'; waveNumber: number }
  | { kind: 'next-wave-launched'; waveNumber: number; jobIds: string[] }
  | { kind: 'epic-completed' };

// ── Reducer ────────────────────────────────────────────────────────────────

/**
 * Reduce one Pipeline-mode epic. Returns a discriminated union describing
 * the action taken for observability + tests.
 *
 * Expects `epic.useEpicOrchestrator === false` and `epic.status === 'in_progress'`.
 * Callers (the cron handler) filter upstream.
 */
export async function reduceEpicWaves(
  epic: EpicWorkflow,
  deps: WaveReducerDeps,
  planOpts?: PlanExecutionOpts,
): Promise<WaveReducerResult> {
  if (!epic.stories || epic.stories.length === 0) {
    return { kind: 'no-op', reason: 'no-stories' };
  }

  // Current wave = highest wave number that has any story with a jobId set.
  // Stories without jobId are not yet launched and therefore not "current".
  const launchedStories = epic.stories.filter((s) => s.jobId);
  if (launchedStories.length === 0) {
    // No story has been launched yet; /start handles wave-1 launch, not us.
    return { kind: 'no-op', reason: 'no-current-wave' };
  }
  const currentWave = Math.max(...launchedStories.map((s) => s.wave ?? 0));
  const currentWaveStories = epic.stories.filter((s) => (s.wave ?? 0) === currentWave);

  // ── 1. Resolve job statuses for current-wave stories. ─────────────────
  const jobsByStory = new Map<string, AgentJob | null>();
  for (const story of currentWaveStories) {
    if (!story.jobId) {
      // Shouldn't happen — `currentWave` was derived from launched stories,
      // but if a wave has mixed launched/unlaunched stories we wait.
      return { kind: 'no-op', reason: 'wave-running' };
    }
    const job = await deps.getJobById(story.jobId);
    jobsByStory.set(story.storyId, job);
  }

  // Story 1.1: NEEDS_ATTENTION pauses the wave. Sibling jobs continue running
  // — we don't propagate — but advancement is blocked until the operator
  // resolves the paused job (Salvage/Retry/Skip/Abort, Stories 1.5-1.8).
  // We surface a distinct `wave-paused` result so observability can tell the
  // difference between "still working" and "waiting on a human."
  const needsAttentionStoryIds = currentWaveStories
    .filter((s) => {
      const job = jobsByStory.get(s.storyId);
      return job !== null && job !== undefined && isPaused(job.status);
    })
    .map((s) => s.storyId);
  if (needsAttentionStoryIds.length > 0) {
    return {
      kind: 'wave-paused',
      waveNumber: currentWave,
      needsAttentionStoryIds,
    };
  }

  const allTerminal = currentWaveStories.every((s) => {
    const job = jobsByStory.get(s.storyId);
    return job !== null && job !== undefined && isTerminal(job.status);
  });
  if (!allTerminal) {
    // Optional: propagate `story.status` forward even while running, since
    // some jobs may have moved PENDING→RUNNING since last persist. Kept
    // minimal here — full story-status sync happens in the `story-statuses-synced`
    // branch below once the wave reaches terminal state.
    return { kind: 'no-op', reason: 'wave-running' };
  }

  // ── 2. Sync story.status from job.status on the epic row. ─────────────
  const mutable = epic.stories.map((s) => ({ ...s }));
  const mutableById = new Map(mutable.map((s) => [s.storyId, s] as const));
  const failedStoryIds: string[] = [];
  for (const story of currentWaveStories) {
    const job = jobsByStory.get(story.storyId);
    if (!job) continue;
    const mstory = mutableById.get(story.storyId);
    if (!mstory) continue;
    if (isSuccess(job.status)) {
      mstory.status = 'done';
    } else if (isTerminal(job.status)) {
      mstory.status = 'failed';
      failedStoryIds.push(story.storyId);
    }
  }

  // If any wave-N story FAILED/STALE: epic → 'fixing'. Do not build-check.
  if (failedStoryIds.length > 0) {
    await deps.updateEpicFields(epic.epicId, {
      stories: mutable,
      status: 'fixing',
    });

    // Pipeline v2.0 PR-7 (G+H): synthesize ONE upsert per failed story keyed
    // on `wave-reducer:test-gate-failed:<storyId>`. Reducer ticks (cron, every
    // status flip) that observe the same failure now bump `recurrenceCount`
    // instead of writing duplicate rows. dino1 forensic: 224 dupes → 1 row.
    if (deps.writeAttentionItem && epic.planId) {
      for (const storyId of failedStoryIds) {
        const story = mutableById.get(storyId);
        const job = jobsByStory.get(storyId);
        if (!story) continue;
        await deps
          .writeAttentionItem({
            planId: epic.planId,
            itemId: deps.uuid(), // legacy field; daemon writer ignores when dedupKey is set
            createdAt: deps.now(),
            resolvedAt: null,
            severity: 'high',
            category: 'test-gate-failed',
            title: `Story failed: ${story.title}`,
            body:
              `Story ${storyId} in wave ${currentWave} finished with ` +
              `job.status=${job?.status ?? 'unknown'}. The epic was moved ` +
              `to "fixing" so you can investigate and retry.`,
            context: {
              epicId: epic.epicId,
              storyId,
              jobId: story.jobId,
            },
            suggestedActions: [
              { label: 'Open story', kind: 'open-story' },
              { label: 'Open logs', kind: 'open-logs' },
              { label: 'Retry step', kind: 'retry-step' },
            ],
            status: 'open',
            // PR-7 (G): stable identifier so subsequent reducer ticks bump
            // recurrence instead of creating duplicates.
            dedupKey: `wave-reducer:test-gate-failed:${storyId}`,
          })
          .catch(() => {
            // swallow — attention writes must never break the reducer
          });
      }
    }

    return {
      kind: 'wave-failed',
      waveNumber: currentWave,
      failedStoryIds,
    };
  }

  // ── 3. All wave-N stories are COMPLETED. Ensure wave build-check exists. ──
  const existingBuildCheckId = epic.waveBuildJobs?.[String(currentWave)];
  if (!existingBuildCheckId) {
    const jobId = deps.uuid();
    const now = deps.now();
    const pipeline = deps.generateWaveBuildPipeline(
      epic.workingDir,
      currentWave,
      currentWaveStories.map((s) => s.title),
    );
    await deps.createJob({
      jobId,
      status: 'PENDING',
      createdAt: now,
      updatedAt: now,
      createdBy: epic.createdBy,
      workingDir: epic.workingDir,
      pipeline,
    });
    const waveBuildJobs = { ...(epic.waveBuildJobs || {}), [String(currentWave)]: jobId };
    await deps.updateEpicFields(epic.epicId, {
      stories: mutable,
      waveBuildJobs,
    });
    return { kind: 'wave-build-check-created', waveNumber: currentWave, jobId };
  }

  // ── 4. Build-check exists; gate on its status. ─────────────────────────
  const buildCheckJob = await deps.getJobById(existingBuildCheckId);
  if (!buildCheckJob || !isTerminal(buildCheckJob.status)) {
    return { kind: 'wave-build-check-pending', waveNumber: currentWave };
  }
  if (!isSuccess(buildCheckJob.status)) {
    // Build failed — halt the epic for operator intervention.
    await deps.updateEpicFields(epic.epicId, {
      stories: mutable,
      status: 'fixing',
    });

    // Pipeline v2.0 PR-7 (G+H): one upsert per (epic, wave) build-check.
    // Cron ticks during the operator's debugging session don't multiply rows.
    if (deps.writeAttentionItem && epic.planId) {
      await deps
        .writeAttentionItem({
          planId: epic.planId,
          itemId: deps.uuid(),
          createdAt: deps.now(),
          resolvedAt: null,
          severity: 'high',
          category: 'test-gate-failed',
          title: `Wave ${currentWave} build-check failed`,
          body:
            `All wave-${currentWave} stories in epic "${epic.title}" completed, but the ` +
            `automated wave-build-check (job ${existingBuildCheckId}) finished with ` +
            `status=${buildCheckJob.status}. Fix the build and re-run the check.`,
          context: {
            epicId: epic.epicId,
            jobId: existingBuildCheckId,
          },
          suggestedActions: [
            { label: 'Open logs', kind: 'open-logs' },
            { label: 'Retry step', kind: 'retry-step' },
          ],
          status: 'open',
          dedupKey: `wave-reducer:wave-build-check-failed:${epic.epicId}:${currentWave}`,
        })
        .catch(() => {
          // swallow — attention writes must never break the reducer
        });
    }

    return { kind: 'wave-build-check-failed', waveNumber: currentWave };
  }

  // ── 5. Build-check passed → advance to wave N+1 or mark epic completed. ─
  const nextWave = currentWave + 1;
  const nextWaveStories = epic.stories.filter((s) => (s.wave ?? 0) === nextWave);
  if (nextWaveStories.length === 0) {
    // No more waves — epic is done.
    await deps.updateEpicFields(epic.epicId, {
      stories: mutable,
      status: 'completed',
    });
    return { kind: 'epic-completed' };
  }

  // Launch wave N+1. We pass the `mutable` array (with wave-N stories now
  // status='done') so the launcher's returned `updatedStories` carries the
  // full up-to-date view.
  const launch = await launchPipelineWave(
    { ...epic, stories: mutable },
    nextWave,
    epic.createdBy,
    deps.now(),
    deps,
    planOpts,
  );
  if (!launch.ok) {
    // Shouldn't happen — we confirmed nextWaveStories.length > 0 — but be
    // defensive. Persist story-status sync and return a no-op.
    await deps.updateEpicFields(epic.epicId, { stories: mutable });
    return { kind: 'no-op', reason: 'wave-running' };
  }
  await deps.updateEpicFields(epic.epicId, {
    stories: launch.updatedStories,
    status: 'in_progress',
  });
  return {
    kind: 'next-wave-launched',
    waveNumber: nextWave,
    jobIds: launch.jobIds,
  };
}

// Re-export so cron handler can import everything from one module.
export type { EpicStory };
