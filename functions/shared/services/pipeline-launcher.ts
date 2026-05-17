import type { EpicStory, EpicWorkflow } from '../types/epic-workflow';
import type { AgentJob, PipelineDefinition } from '../types/agent-orchestrator';
import type { PlanRigor } from '../types/plan';

/**
 * Pipeline-mode launcher — Stories 16.1 + 16.2.
 *
 * `launchPipelineWave(epic, waveNumber, ...)` creates one PENDING step-based
 * job per story in the specified wave. Mutates a *copy* of the stories array
 * to record `story.jobId` and `story.status='running'` on wave-N stories
 * (stories in other waves are returned untouched) and returns the combined
 * array alongside the created jobIds for the caller to persist in a single
 * `updateEpicFields` call.
 *
 * This module is intentionally dependency-free at the I/O layer — it receives
 * `generateStoryPipeline` + a `createJob` function + a uuid source as
 * arguments so it is trivial to test in isolation without booting the full
 * Hono app.
 *
 * Story 16.1 introduced this launcher for wave 1 only. Story 16.2 made it
 * accept an explicit wave number; the cron-driven wave-completion reducer
 * calls it for wave N+1 after wave N finishes.
 */

export interface PipelineLauncherDeps {
  /**
   * The pipeline builder (per-story). In production this is
   * `generateStoryPipeline` from `functions/api/index.ts`; in tests a stub.
   */
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
  /** Agent-jobs repository `createJob` — or any shape-compatible async fn. */
  createJob: (job: AgentJob) => Promise<unknown>;
  /** Source of UUIDs — injectable for deterministic tests. */
  uuid: () => string;
}

/**
 * Plan-level options that cascade into per-story pipelines. Populated by
 * the plan-reducer from the Plan row and threaded through wave-reducer →
 * pipeline-launcher. Phase C.3.
 */
export interface PlanExecutionOpts {
  rigor?: PlanRigor;
  testModel?: string;
  hasBrowserTests?: boolean;
}

export type PipelineLaunchResult =
  | { ok: true; jobIds: string[]; waveNumber: number; updatedStories: EpicStory[] }
  | { ok: false; code: 'no-wave-stories'; message: string };

type LaunchableEpic = Pick<
  EpicWorkflow,
  | 'epicId'
  | 'title'
  | 'workingDir'
  | 'stories'
  | 'devModel'
  | 'devEffort'
  | 'reviewerModel'
  | 'reviewerEffort'
>;

/**
 * Returns the lowest wave number across the epic's stories. Used by
 * `/start` and `/from-xml` autoStart to decide wave 1. Throws if the
 * stories array is empty — caller should guard.
 */
export function findFirstWave(epic: Pick<EpicWorkflow, 'stories'>): number {
  if (!epic.stories || epic.stories.length === 0) {
    throw new Error('findFirstWave: epic has no stories');
  }
  return Math.min(...epic.stories.map((s) => s.wave ?? 0));
}

/**
 * Launch all stories in the specified `waveNumber` as step-based pipeline
 * jobs. Returns the created jobIds, the wave number, and a mutated copy of
 * the stories array (wave-N stories get `jobId` and `status='running'`;
 * stories in other waves are left untouched).
 *
 * The caller is responsible for persisting `updatedStories` back to the
 * epic row — the launcher intentionally does no I/O beyond `createJob`.
 */
/**
 * 2026-05-17 runtime tripwire — abort if invoked from a non-production
 * stage. Belt-and-suspenders against the sst.config.ts deploy-time guard:
 * even if someone bypasses that guard (manually-built Lambda zip, forked
 * deploy, debug-mode invocation), we refuse to write a PENDING job into
 * the shared `futurator-agent-jobs` table when SST_STAGE indicates the
 * caller is not production.
 *
 * SST stamps `SST_STAGE` into every linked Lambda's env. When the var is
 * absent (local node tests, vitest, repl) we don't fire — the test suite
 * relies on calling `launchPipelineWave` directly.
 */
function assertProductionStage(): void {
  const stage = process.env.SST_STAGE;
  if (stage && stage !== 'production') {
    throw new Error(
      `launchPipelineWave was called from SST_STAGE="${stage}" — this is ` +
        `NOT allowed. The shared agent-jobs table is production-only; ` +
        `writing from a non-production stage caused the 2026-05-17 ` +
        `pipeline bifurcation. Decommission this stage or set ` +
        `SST_STAGE=production explicitly.`,
    );
  }
}

export async function launchPipelineWave(
  epic: LaunchableEpic,
  waveNumber: number,
  userId: string,
  now: string,
  deps: PipelineLauncherDeps,
  planOpts?: PlanExecutionOpts,
): Promise<PipelineLaunchResult> {
  assertProductionStage();
  if (!epic.stories || epic.stories.length === 0) {
    return {
      ok: false,
      code: 'no-wave-stories',
      message: 'Epic has no stories to start',
    };
  }
  const waveStories = epic.stories.filter((s) => (s.wave ?? 0) === waveNumber);
  if (waveStories.length === 0) {
    return {
      ok: false,
      code: 'no-wave-stories',
      message: `Epic has no stories in wave ${waveNumber} to start`,
    };
  }

  const opts = {
    devModel: epic.devModel,
    devEffort: epic.devEffort,
    reviewerModel: epic.reviewerModel,
    reviewerEffort: epic.reviewerEffort,
    testModel: planOpts?.testModel,
    epicId: epic.epicId,
    rigor: planOpts?.rigor,
    hasBrowserTests: planOpts?.hasBrowserTests,
  };

  const jobIds: string[] = [];
  const mutable = epic.stories.map((s) => ({ ...s }));
  const byId = new Map(mutable.map((s) => [s.storyId, s] as const));
  for (const story of waveStories) {
    const jobId = deps.uuid();
    const pipeline = deps.generatePipeline(story, epic.title, epic.workingDir, opts);
    await deps.createJob({
      jobId,
      status: 'PENDING',
      createdAt: now,
      updatedAt: now,
      createdBy: userId,
      workingDir: epic.workingDir,
      pipeline,
    });
    const updated = byId.get(story.storyId);
    if (updated) {
      updated.jobId = jobId;
      // PENDING job in the daemon queue — not executing yet. Sync-on-read
      // (api/index.ts) promotes `queued → running` when the daemon picks it up.
      updated.status = 'queued';
    }
    jobIds.push(jobId);
  }

  return { ok: true, jobIds, waveNumber, updatedStories: mutable };
}
