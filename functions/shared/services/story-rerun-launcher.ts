import type { AgentJob, PipelineDefinition } from '../types/agent-orchestrator';
import type { EpicStory, EpicWorkflow } from '../types/epic-workflow';
import type { PlanRigor } from '../types/plan';
import type { PlanExecutionOpts } from './pipeline-launcher';

/**
 * Single-story re-run launcher — Story 16.3 (extended Phase C.3 for rigor).
 *
 * Creates a fresh step-based PENDING job for one story, updating *only* that
 * story's `jobId` + `status` in the epic row (siblings untouched). The caller
 * (Hono handler or cron) persists the returned `updatedStories` in one
 * `updateEpicFields` call.
 *
 * Pure, deps-injected — mirrors `pipeline-launcher.ts` from Story 16.1.
 */

export interface StoryRerunDeps {
  generatePipeline: (
    story: EpicStory,
    epicTitle: string,
    workingDir: string,
    opts: {
      devModel?: string;
      devEffort?: string;
      reviewerModel?: string;
      reviewerEffort?: string;
      testModel?: string;
      epicId?: string;
      rigor?: PlanRigor;
      hasBrowserTests?: boolean;
      planSlug?: string;
      planId?: string;
    },
  ) => PipelineDefinition;
  createJob: (job: AgentJob) => Promise<unknown>;
  uuid: () => string;
}

export type StoryRerunResult =
  | { ok: true; jobId: string; updatedStories: EpicStory[] }
  | { ok: false; code: 'story-not-found'; message: string };

/**
 * Pipeline v2.0 PR-6 (A) — optional prior-job carry-forward inputs.
 *
 * When provided, the new retry job's pipeline is seeded with the prior
 * job's runtime state so the daemon's executePipeline can:
 *   - Skip steps whose `initialStepResults[i].status === 'complete'`
 *   - `--resume <prior session>` on the failed step for warm-context cache hits
 *   - Carry forward extracted variables (AC_TEXT, TOUCH_POINTS, etc.) so the
 *     prework gate / scope detector / etc. don't lose context.
 */
export interface PriorJobState {
  variables?: Record<string, string>;
  sessions?: Record<string, string>;
  stepResults?: AgentJob['stepResults'];
}

export async function launchStoryRerun(
  epic: EpicWorkflow,
  storyId: string,
  userId: string,
  now: string,
  deps: StoryRerunDeps,
  planOpts?: PlanExecutionOpts,
  priorJobState?: PriorJobState,
  /**
   * Extra fields merged into the created job row (e.g. `remediationMerge` so
   * the daemon integrates a QA send-back's fix into `plan/<slug>` on success).
   */
  jobAnnotations?: Partial<AgentJob>,
): Promise<StoryRerunResult> {
  const story = epic.stories.find((s) => s.storyId === storyId);
  if (!story) {
    return {
      ok: false,
      code: 'story-not-found',
      message: `Story ${storyId} not found on epic ${epic.epicId}`,
    };
  }

  // 2026-06-03 — a re-run (QA send-back / manual retry) MUST target the same
  // per-story worktree the wave used, not the App's trunk worktree. Mirror
  // pipeline-launcher.ts: when a planSlug is present, compute
  // `/home/ubuntu/worktrees/<app>/<plan>/<storyId>` and bake it into both the
  // generated pipeline's `cd ${workingDir}` AND the job row's `workingDir` so
  // the daemon materializes/re-uses the story worktree. Without this the rerun
  // ran in `/home/ubuntu/projects/<app>` (trunk) — review-runtime screenshotted
  // the trunk and compile-commit produced STORY_COMMIT_EMPTY against main.
  const appWorktreeSlug = epic.workingDir.replace(/\/+$/, '').split('/').filter(Boolean).pop();
  const useStoryWorktree = !!(planOpts?.planSlug && appWorktreeSlug);
  const effectiveWorkingDir = useStoryWorktree
    ? `/home/ubuntu/worktrees/${appWorktreeSlug}/${planOpts!.planSlug}/${storyId}`
    : epic.workingDir;

  const pipeline = deps.generatePipeline(story, epic.title, effectiveWorkingDir, {
    devModel: epic.devModel,
    devEffort: epic.devEffort,
    reviewerModel: epic.reviewerModel,
    reviewerEffort: epic.reviewerEffort,
    testModel: planOpts?.testModel,
    epicId: epic.epicId,
    rigor: planOpts?.rigor,
    hasBrowserTests: planOpts?.hasBrowserTests,
    planSlug: planOpts?.planSlug,
    planId: planOpts?.planId,
  });

  // PR-6 (A): merge prior runtime state into the pipeline definition. The
  // daemon's executePipeline reads initialStepResults/initialSessions and
  // skips already-complete steps + resumes the failed step's session.
  if (priorJobState) {
    if (priorJobState.variables && Object.keys(priorJobState.variables).length > 0) {
      pipeline.initialVariables = {
        ...(pipeline.initialVariables || {}),
        ...priorJobState.variables,
      };
    }
    if (priorJobState.stepResults && priorJobState.stepResults.length > 0) {
      pipeline.initialStepResults = priorJobState.stepResults;
    }
    if (priorJobState.sessions && Object.keys(priorJobState.sessions).length > 0) {
      pipeline.initialSessions = priorJobState.sessions;
    }
  }

  // F2: chain this retry to the prior attempt's job BEFORE we overwrite
  // story.jobId below, so the prior attempt's events stay reachable (and the
  // per-step retry cap can walk the chain). Captured here because `story` is the
  // pre-rerun row; once we patch `updatedStories` its jobId points at the new job.
  const priorJobId = story.jobId;

  const jobId = deps.uuid();
  await deps.createJob({
    jobId,
    status: 'PENDING',
    createdAt: now,
    updatedAt: now,
    createdBy: userId,
    workingDir: effectiveWorkingDir,
    pipeline,
    ...(priorJobId ? { retryOf: priorJobId } : {}),
    ...jobAnnotations,
  });

  const updatedStories = epic.stories.map((s) =>
    s.storyId === storyId ? { ...s, status: 'queued' as const, jobId } : s,
  );

  return { ok: true, jobId, updatedStories };
}
