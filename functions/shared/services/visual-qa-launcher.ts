import type { AgentJob, PipelineDefinition } from '../types/agent-orchestrator';
import type { EpicStory, EpicWorkflow, VisualTestDef } from '../types/epic-workflow';
import type { Plan } from '../types/plan';
import type { BoilerplateMetadata } from '../boilerplates/types';
import { classifyVisualTest } from './visual-test-classifier';

/**
 * Visual-QA launcher — Story 16.3 + Pipeline v2.0 PR-8a (plan-scoped).
 *
 * Two entrypoints:
 *
 *  • `launchVisualQa(epic, …)` — legacy single-epic launcher. Kept for
 *    `/api/epic-workflows/:id/visual-qa` back-compat. Do NOT call from new
 *    code; new code must use `launchPlanVisualQa`.
 *
 *  • `launchPlanVisualQa(plan, epics, …)` — PR-8a entrypoint. Boots ONE
 *    dev server, runs every visual test across every epic+story in the plan
 *    against that single server, returns one jobId. Replaces the
 *    one-QA-job-per-epic fan-out that wasted ~75% of CPU/RAM (each epic
 *    started its own `npm run dev`).
 *
 * Both entrypoints backfill missing `visualTests` from each story's
 * completed dev-job `variables.VISUAL_TESTS` output before launching.
 * Returns `no-visual-tests` when nothing is collectable.
 */

type FlatVisualTest = VisualTestDef & {
  storyId: string;
  storyTitle: string;
  /** Pipeline v2.0 PR-8a — track originating epic so plan-scoped reports can
   *  group failures back to the right epic in the operator UI. */
  epicId?: string;
  epicTitle?: string;
};

export interface VisualQaDeps {
  getJobById: (jobId: string) => Promise<AgentJob | null>;
  createJob: (job: AgentJob) => Promise<unknown>;
  parseVisualTests: (raw: string) => VisualTestDef[];
  buildQaPipeline: (
    workingDir: string,
    epicTitle: string,
    viewport: string,
    allVisualTests: FlatVisualTest[],
    snapshotPrefix: string,
    port?: number,
  ) => PipelineDefinition;
  uuid: () => string;
}

export interface LaunchVisualQaOptions {
  /**
   * Dev-server port this QA job should use. Plan-level fan-out passes
   * `5173 + epicIndex` so parallel epic QA jobs don't race for the same
   * port. Single-epic callers can omit — defaults to 5173.
   */
  port?: number;
}

export type VisualQaResult =
  | {
      ok: true;
      jobId: string;
      storiesChanged: boolean;
      updatedStories: EpicStory[];
    }
  | { ok: false; code: 'no-visual-tests'; message: string };

/**
 * Backfill missing `visualTests` for a single epic's stories from each
 * story's completed dev job `variables.VISUAL_TESTS` output. Used by both
 * launcher entrypoints. Returns `{ stories, changed }` where `changed` is
 * true if any story was enriched (caller should persist back to DDB).
 */
async function backfillVisualTests(
  stories: readonly EpicStory[],
  deps: Pick<VisualQaDeps, 'getJobById' | 'parseVisualTests'>,
): Promise<{ stories: EpicStory[]; changed: boolean }> {
  let changed = false;
  const enriched: EpicStory[] = [];
  for (const story of stories) {
    if (story.visualTests && story.visualTests.length > 0) {
      enriched.push(story);
      continue;
    }
    if (!story.hasBrowserTests || !story.jobId) {
      enriched.push(story);
      continue;
    }
    const job = await deps.getJobById(story.jobId);
    const rawVT = job?.variables?.VISUAL_TESTS;
    if (!rawVT) {
      enriched.push(story);
      continue;
    }
    const parsed = deps.parseVisualTests(rawVT);
    if (parsed.length > 0) {
      changed = true;
      enriched.push({ ...story, visualTests: parsed });
    } else {
      enriched.push(story);
    }
  }
  return { stories: enriched, changed };
}

export async function launchVisualQa(
  epic: EpicWorkflow,
  userId: string,
  now: string,
  deps: VisualQaDeps,
  options: LaunchVisualQaOptions = {},
): Promise<VisualQaResult> {
  const { stories: enrichedStories, changed: storiesChanged } = await backfillVisualTests(
    epic.stories,
    deps,
  );

  const allVisualTests: FlatVisualTest[] = enrichedStories
    .filter((s) => s.visualTests && s.visualTests.length > 0)
    .flatMap((s) =>
      s.visualTests!.map((vt) => ({ ...vt, storyId: s.storyId, storyTitle: s.title })),
    );

  if (allVisualTests.length === 0) {
    return {
      ok: false,
      code: 'no-visual-tests',
      message:
        'No visual tests defined in any story. Dev agents may not have produced VISUAL_TESTS output.',
    };
  }

  const viewport = epic.testingProfile?.viewport || '1280x720';
  // Allocate the jobId up-front so the snapshot prefix can reference it.
  // Screenshots land in s3://futurator-ai-website/qa-snapshots/<appName>/<jobId>/
  // and are served publicly via CloudFront at https://futurator.ai/qa-snapshots/...
  const jobId = deps.uuid();
  const appName = epic.workingDir.split('/').filter(Boolean).pop() || 'app';
  const snapshotPrefix = `qa-snapshots/${appName}/${jobId}/`;
  const pipeline = deps.buildQaPipeline(
    epic.workingDir,
    epic.title,
    viewport,
    allVisualTests,
    snapshotPrefix,
    options.port,
  );
  // Pre-populate variables the UI reads before the agent has emitted
  // anything: DEV_SERVER_PORT + APP_NAME let the VQA logs panel render a
  // "Preview dev server" link as soon as qa-start-server completes.
  const port = options.port ?? 5173;
  await deps.createJob({
    jobId,
    status: 'PENDING',
    createdAt: now,
    updatedAt: now,
    createdBy: userId,
    workingDir: epic.workingDir,
    pipeline,
    variables: {
      DEV_SERVER_PORT: String(port),
      APP_NAME: appName,
    },
  });

  return { ok: true, jobId, storiesChanged, updatedStories: enrichedStories };
}

// ────────────────────────────────────────────────────────────────────
// Pipeline v2.0 PR-8a — plan-scoped launcher
// ────────────────────────────────────────────────────────────────────

export type PlanVisualQaResult =
  | {
      ok: true;
      jobId: string;
      /** Per-epic enriched stories (only entries whose stories were backfilled
       *  appear here — caller iterates this map and writes each via
       *  `epicRepo.updateEpicFields(epicId, { stories })`). */
      updatedStoriesByEpic: Map<string, EpicStory[]>;
      /** Total visual tests fed into the QA pipeline across all epics. */
      testCount: number;
    }
  | { ok: false; code: 'no-visual-tests'; message: string };

/**
 * Pipeline v2.0 PR-8a — plan-scoped Visual QA launcher.
 *
 * Aggregates every visual test from every story in every epic into a single
 * flat list and launches ONE QA job against ONE dev server (port 5173).
 * Replaces `launchVisualQa(epic, …)` callsites that previously fanned out
 * one QA job per epic.
 *
 * Why one server instead of N:
 *   • One `npm run dev` instead of N → ~75% less RAM/CPU on the daemon EC2
 *     (was the proximate cause of two t2.micro kernel hangs).
 *   • One Sonnet judge call against one canonical app — no cross-epic
 *     screenshot drift, no port-collision races.
 *   • Plan = unit-of-deploy = unit-of-test. Epics are intra-plan ordering
 *     metadata, not deployable units; QA at the deployable boundary.
 *
 * The QA prompt receives `epicId`/`epicTitle` per visual test so the
 * downstream report can still group failures by epic for the operator's
 * triage UI — no information loss vs the legacy fan-out.
 *
 * Behavior on enrichment: each epic's stories may need backfilling from
 * the dev job's `variables.VISUAL_TESTS`. The caller is responsible for
 * persisting `updatedStoriesByEpic` per-epic before reading the QA job's
 * results, otherwise the report→story linking will look up storyIds
 * without `visualTests` arrays.
 */
export async function launchPlanVisualQa(
  plan: Plan,
  epics: readonly EpicWorkflow[],
  userId: string,
  now: string,
  deps: VisualQaDeps,
): Promise<PlanVisualQaResult> {
  if (epics.length === 0) {
    return {
      ok: false,
      code: 'no-visual-tests',
      message: 'Plan has no epics; nothing to QA.',
    };
  }

  // Pick the first epic that defines a viewport, falling back to the
  // standard 1280x720. Epic-level testingProfile is the legacy carrier; a
  // future PR will move this to plan.testingProfile.
  const viewport =
    epics.find((e) => e.testingProfile?.viewport)?.testingProfile?.viewport ??
    plan.testingProfile?.viewport ??
    '1280x720';

  // Backfill + flatten visual tests across every (epic, story).
  const updatedStoriesByEpic = new Map<string, EpicStory[]>();
  const allVisualTests: FlatVisualTest[] = [];
  for (const epic of epics) {
    const { stories: enriched, changed } = await backfillVisualTests(epic.stories, deps);
    if (changed) updatedStoriesByEpic.set(epic.epicId, enriched);
    for (const s of enriched) {
      if (!s.visualTests || s.visualTests.length === 0) continue;
      for (const vt of s.visualTests) {
        allVisualTests.push({
          ...vt,
          storyId: s.storyId,
          storyTitle: s.title,
          epicId: epic.epicId,
          epicTitle: epic.title,
        });
      }
    }
  }

  if (allVisualTests.length === 0) {
    return {
      ok: false,
      code: 'no-visual-tests',
      message:
        'No visual tests defined in any story across the plan. Dev agents may not have produced VISUAL_TESTS output.',
    };
  }

  const jobId = deps.uuid();
  // Snapshot prefix uses the plan name so cross-plan QA artifacts don't
  // collide in the public bucket. plan.name is the locked, slug-validated
  // identifier (= folder slug = deploy slug).
  const appName = plan.name;
  const snapshotPrefix = `qa-snapshots/${appName}/${jobId}/`;

  // Plan-scoped QA always uses port 5173 — there is no concurrent fan-out
  // to escape from. Multiple plans running QA concurrently still need
  // different ports, but the daemon serializes plan-scoped jobs in a
  // single in-flight slot so collisions are impossible by construction.
  const port = 5173;

  // Title for the QA prompt: prefer human-readable displayName, fall back
  // to slug. The QA prompt uses this purely for the report header.
  const reportTitle = plan.displayName ?? plan.name;

  const pipeline = deps.buildQaPipeline(
    plan.workingDir,
    reportTitle,
    viewport,
    allVisualTests,
    snapshotPrefix,
    port,
  );

  await deps.createJob({
    jobId,
    status: 'PENDING',
    createdAt: now,
    updatedAt: now,
    createdBy: userId,
    workingDir: plan.workingDir,
    pipeline,
    variables: {
      DEV_SERVER_PORT: String(port),
      APP_NAME: appName,
      PLAN_ID: plan.planId,
    },
  });

  return {
    ok: true,
    jobId,
    updatedStoriesByEpic,
    testCount: allVisualTests.length,
  };
}

// ────────────────────────────────────────────────────────────────────
// Pipeline v2.0 PR-8 (Q4) — two-stage launcher (aggregate + execute)
// ────────────────────────────────────────────────────────────────────

/**
 * Pipeline v2.0 PR-8 — extended deps interface for the aggregate +
 * execute pipeline builders. Separate from `VisualQaDeps` so legacy
 * callers don't have to migrate atomically.
 */
export interface PlanQaDeps extends Omit<VisualQaDeps, 'buildQaPipeline'> {
  buildQaAggregatePipeline: (inputs: {
    plan: Plan;
    allVisualTests: ReadonlyArray<FlatVisualTest>;
    snapshotPrefix: string;
    jobId: string;
    boilerplate?: BoilerplateMetadata['qaContext'];
    port?: number;
    acceptanceCriteria?: ReadonlyArray<{ id: string; needsBrowser: boolean }>;
  }) => PipelineDefinition;
  buildQaExecutePipeline: (inputs: {
    plan: Plan;
    allVisualTests: ReadonlyArray<FlatVisualTest>;
    snapshotPrefix: string;
    jobId: string;
    boilerplate?: BoilerplateMetadata['qaContext'];
    port?: number;
  }) => PipelineDefinition;
}

export type PlanQaAggregateResult =
  | {
      ok: true;
      jobId: string;
      updatedStoriesByEpic: Map<string, EpicStory[]>;
      testCount: number;
    }
  | { ok: false; code: 'no-visual-tests'; message: string };

/**
 * Pipeline v2.0 PR-8 (Q4.1) — launch the QA aggregate stage.
 *
 * Creates a single-step shell job that classifies tests, runs coverage
 * + specificity checks, writes `visual-tests-draft.md` to the plan
 * working dir, and emits the contract-review variables. Job ends with
 * `OVERALL_VERDICT=PENDING_APPROVAL`. The execute stage doesn't run
 * until the operator calls `POST /api/plans/:id/qa-contract/approve`.
 *
 * Returns the `qaAggregateJobId` for the caller to persist on the plan.
 */
export async function launchPlanQaAggregate(
  plan: Plan,
  epics: readonly EpicWorkflow[],
  userId: string,
  now: string,
  deps: PlanQaDeps,
  options: { boilerplate?: BoilerplateMetadata['qaContext'] } = {},
): Promise<PlanQaAggregateResult> {
  if (epics.length === 0) {
    return { ok: false, code: 'no-visual-tests', message: 'Plan has no epics.' };
  }

  // Backfill stories first (in case the dev agent left bare visualTests
  // blocks the schema needs to fill in), then build an AC-needsBrowser
  // map so per-test classification (below) can raise browser ACs to L1+.
  const updatedStoriesByEpic = new Map<string, EpicStory[]>();
  const enrichedEpics: Array<{
    epicId: string;
    epicTitle: string;
    stories: EpicStory[];
  }> = [];
  for (const epic of epics) {
    const { stories: enriched, changed } = await backfillVisualTests(epic.stories, deps);
    if (changed) updatedStoriesByEpic.set(epic.epicId, enriched);
    enrichedEpics.push({ epicId: epic.epicId, epicTitle: epic.title, stories: enriched });
  }

  // Q4.3 — collect every acceptance criterion across the plan's epics
  // so qa-aggregate's coverage check can flag needsBrowser ACs without
  // tests. PR-62 — same map is reused to drive the per-test needsBrowser
  // floor in classifyVisualTest below.
  const acceptanceCriteria: Array<{ id: string; needsBrowser: boolean }> = [];
  const needsBrowserByAcId = new Map<string, boolean>();
  for (const epic of enrichedEpics) {
    for (const story of epic.stories) {
      for (const c of story.criteria ?? []) {
        acceptanceCriteria.push({ id: c.id, needsBrowser: c.needsBrowser });
        needsBrowserByAcId.set(c.id, c.needsBrowser);
      }
    }
  }

  // Now classify each test with both rigor + the AC's needsBrowser flag.
  // PR-8f #2 — pass plan.rigor so the launcher's pre-classification
  // matches the qa-aggregate shell step's output (both apply the
  // rigor floor).
  // PR-62 — pass acNeedsBrowser so browser-tagged ACs never get L0.
  const allVisualTests: FlatVisualTest[] = [];
  for (const epic of enrichedEpics) {
    for (const s of epic.stories) {
      if (!s.visualTests || s.visualTests.length === 0) continue;
      for (const vt of s.visualTests) {
        const acNeedsBrowser = vt.criteriaRef
          ? (needsBrowserByAcId.get(vt.criteriaRef) ?? false)
          : false;
        const c = classifyVisualTest(vt, plan.rigor, acNeedsBrowser);
        allVisualTests.push({
          ...vt,
          level: c.level,
          levelOverridden: c.rigorFloored ? false : !!vt.level,
          storyId: s.storyId,
          storyTitle: s.title,
          epicId: epic.epicId,
          epicTitle: epic.epicTitle,
        });
      }
    }
  }

  if (allVisualTests.length === 0) {
    return {
      ok: false,
      code: 'no-visual-tests',
      message:
        'No visual tests defined in any story across the plan. Dev agents may not have produced VISUAL_TESTS output.',
    };
  }

  const jobId = deps.uuid();
  const appName = plan.name;
  const snapshotPrefix = `qa-snapshots/${appName}/${jobId}/`;

  const pipeline = deps.buildQaAggregatePipeline({
    plan,
    allVisualTests,
    snapshotPrefix,
    jobId,
    boilerplate: options.boilerplate,
    acceptanceCriteria,
  });

  await deps.createJob({
    jobId,
    status: 'PENDING',
    createdAt: now,
    updatedAt: now,
    createdBy: userId,
    workingDir: plan.workingDir,
    pipeline,
    variables: {
      APP_NAME: appName,
      PLAN_ID: plan.planId,
      QA_STAGE: 'aggregate',
    },
  });

  return { ok: true, jobId, updatedStoriesByEpic, testCount: allVisualTests.length };
}

export type PlanQaExecuteResult =
  | { ok: true; jobId: string; testCount: number }
  | { ok: false; code: 'no-approved-tests'; message: string };

/**
 * Pipeline v2.0 PR-8 (Q4.2) — launch the QA execute stage.
 *
 * Called from `POST /api/plans/:id/qa-contract/approve` after the
 * operator has reviewed `visual-tests-draft.md`. Takes the approved
 * test list (which may differ from the draft — operator can edit/add/
 * remove during review), writes `visual-tests-approved.md`, and creates
 * the seven-step execute pipeline (qa-prepare → judges → qa-report →
 * qa-cleanup).
 *
 * The approved test list is the OPERATOR'S decision. This launcher
 * trusts it — no re-classification, no coverage check. The contract
 * gate already did that.
 */
export async function launchPlanQaExecute(
  plan: Plan,
  approvedTests: ReadonlyArray<FlatVisualTest>,
  userId: string,
  now: string,
  deps: PlanQaDeps,
  options: { boilerplate?: BoilerplateMetadata['qaContext']; port?: number } = {},
): Promise<PlanQaExecuteResult> {
  if (approvedTests.length === 0) {
    return {
      ok: false,
      code: 'no-approved-tests',
      message: 'Operator approved zero tests — nothing to execute.',
    };
  }

  // Every approved test must have a level. Defensive — the contract
  // approval API enforces this, but pipeline builders rely on it.
  const finalTests: FlatVisualTest[] = approvedTests.map((t) => {
    if (t.level) return t;
    const c = classifyVisualTest(t);
    return { ...t, level: c.level };
  });

  const jobId = deps.uuid();
  const appName = plan.name;
  const snapshotPrefix = `qa-snapshots/${appName}/${jobId}/`;

  const pipeline = deps.buildQaExecutePipeline({
    plan,
    allVisualTests: finalTests,
    snapshotPrefix,
    jobId,
    boilerplate: options.boilerplate,
    port: options.port,
  });

  const port = options.port ?? options.boilerplate?.defaultPort ?? 5173;
  await deps.createJob({
    jobId,
    status: 'PENDING',
    createdAt: now,
    updatedAt: now,
    createdBy: userId,
    workingDir: plan.workingDir,
    pipeline,
    variables: {
      APP_NAME: appName,
      PLAN_ID: plan.planId,
      QA_STAGE: 'execute',
      DEV_SERVER_PORT: String(port),
    },
  });

  return { ok: true, jobId, testCount: finalTests.length };
}
