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
    },
  ) => PipelineDefinition;
  createJob: (job: AgentJob) => Promise<unknown>;
  uuid: () => string;
}

export type StoryRerunResult =
  | { ok: true; jobId: string; updatedStories: EpicStory[] }
  | { ok: false; code: 'story-not-found'; message: string };

export async function launchStoryRerun(
  epic: EpicWorkflow,
  storyId: string,
  userId: string,
  now: string,
  deps: StoryRerunDeps,
  planOpts?: PlanExecutionOpts,
): Promise<StoryRerunResult> {
  const story = epic.stories.find((s) => s.storyId === storyId);
  if (!story) {
    return {
      ok: false,
      code: 'story-not-found',
      message: `Story ${storyId} not found on epic ${epic.epicId}`,
    };
  }

  const pipeline = deps.generatePipeline(story, epic.title, epic.workingDir, {
    devModel: epic.devModel,
    devEffort: epic.devEffort,
    reviewerModel: epic.reviewerModel,
    reviewerEffort: epic.reviewerEffort,
    testModel: planOpts?.testModel,
    epicId: epic.epicId,
    rigor: planOpts?.rigor,
    hasBrowserTests: planOpts?.hasBrowserTests,
  });

  const jobId = deps.uuid();
  await deps.createJob({
    jobId,
    status: 'PENDING',
    createdAt: now,
    updatedAt: now,
    createdBy: userId,
    workingDir: epic.workingDir,
    pipeline,
  });

  const updatedStories = epic.stories.map((s) =>
    s.storyId === storyId ? { ...s, status: 'queued' as const, jobId } : s,
  );

  return { ok: true, jobId, updatedStories };
}
