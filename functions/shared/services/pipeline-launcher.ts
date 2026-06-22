import type { EpicStory, EpicWorkflow } from '../types/epic-workflow';
import type { AgentJob, PipelineDefinition } from '../types/agent-orchestrator';
import type { PlanRigor } from '../types/plan';
// D3-2 — mid-plan re-serialize from persisted actualTouchPoints (no-op on fresh plans).
import { recomputePendingStoryWaves } from './story-waves';

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
      /**
       * 2026-05-19 — kebab-case plan slug. When set, the story pipeline's
       * compile-commit-on-pass step checks out (creating if necessary)
       * `plan/<slug>` before staging — so daemon commits land on a per-plan
       * branch instead of the worktree's default (typically `main` for
       * brownfield clones). Absent → preserves prior behaviour (commits to
       * whatever branch the worktree is on).
       */
      planSlug?: string;
      /** 2026-05-19 — DDB Plan row id. Stamped into commit trailers. */
      planId?: string;
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
  /**
   * 2026-05-19 — cascades into the story pipeline as the per-plan branch
   * name (`plan/<slug>`). Set this to the Plan row's `name` field.
   */
  planSlug?: string;
  /**
   * 2026-05-19 — DDB Plan row id. Stamped into commit-message trailers
   * (`Plan-Id: <id>`) so delete cascades can grep main for residual
   * attribution. Set this to the Plan row's `planId` field.
   */
  planId?: string;
  /**
   * Story 20.12 (party-push Epic 20) — pin the per-story worktree to an
   * exact commit SHA at job-creation time, instead of the plan branch's
   * HEAD-at-execution-time. Pre-fix, a party-debate continuing after the
   * operator clicked "Start story-pipeline from this branch" (Epic 22 UI)
   * could move the goalposts mid-run — the pipeline would compile against
   * whatever the party branch's HEAD happened to be when the daemon
   * picked up the first story.
   *
   * When set, the story-pipeline's `compile-commit-on-pass` step does
   * `git checkout <sha>` before `git checkout -b plan/<slug>` — the plan
   * branch starts at the pinned SHA, not main's current HEAD. Validated
   * upstream against `/^[a-f0-9]{40}$/`; the launcher trusts the value.
   *
   * Optional: when undefined, current behavior preserved (plan branch
   * starts at main's HEAD).
   */
  sourceCommitSha?: string;
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

/**
 * Story 20.12 — full-SHA validator. Returns true for exactly 40 lowercase
 * hex chars. Callers (the API route accepting `sourceCommitSha` in the
 * body) should validate input through this BEFORE handing it to
 * `launchPipelineWave`, so a bad SHA returns 400 instead of producing a
 * pipeline whose `git checkout <bad-sha>` will silently fail at runtime.
 *
 * Short SHAs (7-12 chars) are intentionally rejected — git accepts them
 * but we want the baked pipeline's checkout to be unambiguous across
 * worktree contexts.
 */
export const SOURCE_COMMIT_SHA_REGEX = /^[a-f0-9]{40}$/;

export function isValidSourceCommitSha(sha: unknown): sha is string {
  return typeof sha === 'string' && SOURCE_COMMIT_SHA_REGEX.test(sha);
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
  // Defensive: reject malformed `sourceCommitSha` at the launcher boundary
  // in case an upstream caller forgot to validate. Throwing here forces a
  // 500 (rather than silently baking a broken checkout into the job row).
  if (planOpts?.sourceCommitSha && !SOURCE_COMMIT_SHA_REGEX.test(planOpts.sourceCommitSha)) {
    throw new Error(
      `launchPipelineWave: sourceCommitSha must be a 40-char lowercase hex string; received "${planOpts.sourceCommitSha}"`,
    );
  }
  if (!epic.stories || epic.stories.length === 0) {
    return {
      ok: false,
      code: 'no-wave-stories',
      message: 'Epic has no stories to start',
    };
  }

  // D3-2 (2026-06-22) — mid-plan re-serialize. Before selecting this wave's
  // stories, recompute waves honoring each pending story's DECLARED ∪ MEASURED
  // touch points (`actualTouchPoints`, recorded by the dev-scope gate on a prior
  // run). A still-pending sibling that now collides on a file neither declared
  // is bumped to a later wave HERE — so it serializes instead of colliding at
  // the merge gate. No-op on a fresh plan (no story has actualTouchPoints yet);
  // forward-only + reassignable-only, so a running/done story is never moved.
  // The bumped waves ride out on `updatedStories` (the caller persists them).
  const { stories: rewaved, changed: reserialized } = recomputePendingStoryWaves(epic.stories);
  const effectiveStories = reserialized.length > 0 ? rewaved : epic.stories;

  const waveStories = effectiveStories.filter((s) => (s.wave ?? 0) === waveNumber);
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
    planSlug: planOpts?.planSlug,
    planId: planOpts?.planId,
    sourceCommitSha: planOpts?.sourceCommitSha,
  };

  // 2026-05-19 — Phase 1 worktree rollout. When a planSlug is present the
  // launcher computes the per-story worktree path
  // `/home/ubuntu/worktrees/<app>/<plan>/<storyId>/` and bakes it into both
  // the job row's `workingDir` AND every shell step's `cd ${workingDir}`
  // (via generatePipeline). The daemon materializes the worktree on first
  // pickup (git worktree add + node_modules symlink).
  //
  // Falls back to `epic.workingDir` (the App's shared worktree) when
  // planSlug is absent, preserving the legacy single-worktree contract
  // for plans created before the rollout or any caller that intentionally
  // wants the old model.
  const appWorktreeSlug = epic.workingDir.replace(/\/+$/, '').split('/').filter(Boolean).pop();
  const useStoryWorktree = !!(planOpts?.planSlug && appWorktreeSlug);
  const storyWorktreeFor = (storyId: string) =>
    `/home/ubuntu/worktrees/${appWorktreeSlug}/${planOpts!.planSlug}/${storyId}`;

  const jobIds: string[] = [];
  // Build the mutable copy from the (possibly re-waved) stories so the D3-2
  // bumps persist alongside the jobId/status writes below.
  const mutable = effectiveStories.map((s) => ({ ...s }));
  const byId = new Map(mutable.map((s) => [s.storyId, s] as const));
  for (const story of waveStories) {
    const jobId = deps.uuid();
    const perStoryWorkingDir = useStoryWorktree ? storyWorktreeFor(story.storyId) : epic.workingDir;
    const pipeline = deps.generatePipeline(story, epic.title, perStoryWorkingDir, opts);
    await deps.createJob({
      jobId,
      status: 'PENDING',
      createdAt: now,
      updatedAt: now,
      createdBy: userId,
      // workingDir is the EFFECTIVE working dir: per-story worktree when
      // useStoryWorktree, else the App's shared worktree. The daemon's
      // job dispatcher checks this path against the worktree-root convention
      // to decide whether to materialize a worktree before executing.
      workingDir: perStoryWorkingDir,
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
