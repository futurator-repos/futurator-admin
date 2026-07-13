import type { Context } from 'hono';
import type { z } from 'zod';

import { AppError } from '../errors';
import {
  BOILERPLATE_REGISTRY,
  normalizeBoilerplateType,
  type BoilerplateType,
} from '../boilerplates/registry';
import { createRepoFromTemplate, GitHubError } from '../github/connector';
import { defaultCostCeiling } from './cost-ceiling-defaults';
import type { App } from '../types/app';
import type { Plan } from '../types/plan';
import type { StoryNodeRow, StoryNodeState } from '../types/plan-spec';
import type { planStatusSchema } from '../schemas/plan-schema';
import { dispatchPipelineSchema } from '../schemas/pipeline-dispatch-schema';
import * as appRepo from '../repositories/app-repository';
import * as planRepo from '../repositories/plan-repository';
import * as agentJobsRepo from '../repositories/agent-jobs-repository';
import * as storyNodeRepo from '../repositories/story-node-repository';

/**
 * External pipeline-dispatch service (NEW machine-callable surface).
 *
 * Reuses the Labs3 `POST /api/plans/quick-p3` create flow verbatim, but reached
 * by an external `x-queue-key` caller instead of the operator JWT. `createdBy`
 * carries the caller's `source` (`external:<source>`) — there is no JWT user —
 * exactly how the queue-ingest path stamps `createdBy: 'external'`.
 *
 * The stage mapper (`derivePipelineStage`) collapses the full internal
 * plan-status × story-node-state space into the eight external stages the
 * caller polls, honestly: it NEVER reports a later stage than the pipeline is
 * actually in, and every answer names the predicate that fired so it is
 * reproducible from the row fields.
 */

// ─────────────────────────────────────────────────────────────────────────────
// Create — intent → running Pipeline-3 plan (faithful copy of quick-p3).
// ─────────────────────────────────────────────────────────────────────────────

export interface CreatePipelineRunInput {
  intent: string;
  name?: string;
  /** Default ON — auto-fix + re-run QA on a blocking verdict. */
  qaAutopilot?: boolean;
  /** Stamped onto the app/plan/job rows (no JWT user on the external path). */
  createdBy: string;
}

export async function createPipelineRunFromIntent({
  intent,
  name,
  qaAutopilot: qaAutopilotIn,
  createdBy,
}: CreatePipelineRunInput): Promise<{ planId: string; appId: string; jobId: string }> {
  const qaAutopilot = qaAutopilotIn ?? true;

  // Unique throwaway app slug (fresh app per intent) — sanitized + random suffix.
  const base =
    (name || intent)
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 24) || 'quick';
  const appId = `${base.replace(/^[^a-z]/, 'q')}-${crypto.randomUUID().slice(0, 6)}`.slice(0, 40);
  const boilerplateType = normalizeBoilerplateType('nextjs-canvas-game');
  const meta = BOILERPLATE_REGISTRY[boilerplateType as BoilerplateType];
  const now = new Date().toISOString();

  // Scaffold the repo from the boilerplate template. A GitHubError propagates to
  // the handler, which relays it as an HTTP status (same as quick-p3).
  const [tOwner, tRepo] = meta.templateRepo.split('/');
  const { data } = await createRepoFromTemplate(tOwner, tRepo, appId);
  if ('existing' in data && data.existing)
    throw new AppError('REPO_EXISTS', `repo ${appId} exists`, 409);

  const app: App = {
    appId,
    displayName: base,
    workingDir: `/home/ubuntu/projects/${appId}`,
    executionMode: 'pipeline',
    currentlyDeployedPlanId: null,
    deployJobIds: [],
    workingTreeStatus: 'clean',
    boilerplateType,
    bmadEnabled: false,
    createdAt: now,
    updatedAt: now,
  };
  const bootstrapJobId = crypto.randomUUID();
  await appRepo.createAppAndBootstrapJob(app, {
    jobId: bootstrapJobId,
    status: 'PENDING',
    createdAt: now,
    updatedAt: now,
    createdBy,
    workingDir: app.workingDir,
    jobType: 'app-bootstrap',
    appBootstrapPayload: {
      appId,
      boilerplateType,
      bmadEnabled: false,
      augmentFiles: meta.augmentFiles,
      packageJsonScripts: meta.packageJsonScripts ?? null,
      packageJsonDevDependencies: meta.packageJsonDevDependencies ?? null,
      defaultSkillLoadout: meta.defaultSkillLoadout ?? null,
    },
  });

  const planId = crypto.randomUUID();
  const plan: Plan = {
    planId,
    name: appId,
    displayName: `${base} — quick`,
    intent,
    description: '',
    status: 'concept',
    epicIds: [],
    appId,
    workingDir: app.workingDir,
    executionMode: 'pipeline',
    rigor: 'mvp',
    totalCostUsd: 0,
    totalStories: 0,
    doneStories: 0,
    costCeilingUsd: defaultCostCeiling('mvp'),
    qaAutopilot,
    qaAutoFixRounds: 0,
    createdAt: now,
    updatedAt: now,
    createdBy,
  };
  await planRepo.createPlan(plan);

  // The generation job — waits for the scaffold, then one Claude call → StoryNodes.
  const genJobId = crypto.randomUUID();
  await agentJobsRepo.createJob({
    jobId: genJobId,
    status: 'PENDING',
    createdAt: now,
    updatedAt: now,
    createdBy,
    workingDir: app.workingDir,
    jobType: 'quick-planspec',
    quickPlanspecPayload: {
      planId,
      appId,
      intent,
      appBootstrapJobId: bootstrapJobId,
      // Boilerplate metadata, NOT a pipeline constant — the planner prompt names
      // the real seam hook for whatever boilerplate scaffolded this app.
      seamHook: meta.testHarness?.seamHook,
    },
  });

  return { planId, appId, jobId: genJobId };
}

// ─────────────────────────────────────────────────────────────────────────────
// Stage mapper — internal plan/story rows → external pipeline stage.
// ─────────────────────────────────────────────────────────────────────────────

export type PipelineStage =
  | 'queued'
  | 'concept'
  | 'developing'
  | 'vqa'
  | 'deployment'
  | 'completed'
  | 'failed'
  | 'blocked';

export interface PipelineStageView {
  stage: PipelineStage;
  /** Names the predicate that fired — every answer is reproducible from rows. */
  detail: string;
  stories: { done: number; total: number };
  currentWave: number | null;
  totalWaves: number | null;
  devUrl?: string;
  stagingUrl?: string;
  deployUrl?: string;
  branch?: string;
}

/** The 7-value RUNTIME status set (schema/rows carry 'abandoned', which the
 *  narrower `PlanStatus` type omits). Type the mapper's view of status here. */
type RuntimePlanStatus = z.infer<typeof planStatusSchema>;

const RUNNING_STATES: StoryNodeState[] = ['ready', 'claimed', 'developing', 'merging', 'verifying'];
const TERMINAL_STATES: StoryNodeState[] = ['done', 'failed'];

/**
 * The FROZEN promote gate (mirrors index.ts isDeliverable): deployed-app QA has
 * passed iff the automated pass-mark is set, OR the operator approved AND the
 * approval is pinned to the current commit (or no commit is pinned yet).
 */
function isDeliverable(plan: Plan): boolean {
  return (
    Boolean(plan.qaVerifiedAt) ||
    (plan.p3QaVerdict?.decision === 'approved' &&
      (!plan.qaCommitSha || plan.p3QaVerdict.approvedSha === plan.qaCommitSha))
  );
}

/**
 * Pure function (no I/O — caller fetches rows). Collapses the internal
 * plan-status × story-node-state space into the eight external stages.
 * Evaluation is STRICTLY ORDERED first-match:
 *   failed → completed → blocked(a/b/c) → queued → concept → developing → vqa
 *   → deployment → default 'blocked' (unknown-status).
 *
 * Never reports a later stage than the pipeline is actually in.
 *
 * `blocked(b)` has an eventual-consistency window: a blocking verdict that just
 * landed reports 'vqa' until the wave-completion cron consumes an autopilot
 * round — that is truthful (automation is still pending, not wedged).
 */
export function derivePipelineStage(plan: Plan, storyNodes: StoryNodeRow[]): PipelineStageView {
  const status = plan.status as RuntimePlanStatus;

  // ── progress (P3 source of truth is the plan-spec-graph, not plan rollups) ──
  const total = storyNodes.length;
  const stories =
    total === 0
      ? { done: plan.doneStories ?? 0, total: plan.totalStories ?? 0 }
      : { done: storyNodes.filter((n) => n.state === 'done').length, total };

  const nonTerminal = storyNodes.filter((n) => !TERMINAL_STATES.includes(n.state));
  const currentWave =
    nonTerminal.length > 0
      ? Math.min(...nonTerminal.map((n) => n.cohortBatch))
      : storyNodes.length > 0
        ? Math.max(...storyNodes.map((n) => n.cohortBatch))
        : null;
  const totalWaves =
    storyNodes.length > 0 ? Math.max(...storyNodes.map((n) => n.cohortBatch)) + 1 : null;

  const branch = `plan/${plan.name}`;
  const view = (stage: PipelineStage, detail: string, extra?: Partial<PipelineStageView>) => ({
    stage,
    detail,
    stories,
    currentWave,
    totalWaves,
    branch,
    ...extra,
  });

  // 1. failed — the only terminal-without-delivery statuses. Evaluate FIRST.
  if (status === 'abandoned' || status === 'archived')
    return view('failed', `plan.status='${status}' (terminal without delivery)`);

  // 2. completed — operator-marked delivered (nothing auto-flips this).
  if (status === 'delivered') return view('completed', "plan.status='delivered'");

  // 3. blocked — three real needs-human wedges, checked before queued/dev/vqa.
  //   (a) START-GATE: readiness gate refused /start (concept, un-bypassed, unstarted).
  if (
    status === 'concept' &&
    plan.checkoutGates?.blocks === true &&
    !plan.checkoutGates.bypassedByYolo &&
    !plan.startedAt
  )
    return view('blocked', 'START-GATE: readiness gate blocked /start (checkoutGates.blocks)');

  //   (b) QA-EXHAUSTED: a red, undecided verdict sits awaiting the operator once
  //       autopilot/integrator automation is spent (else it is still 'vqa').
  const autofixMax = Number(process.env.P3_QA_AUTOFIX_MAX ?? 2);
  if (
    status === 'review' &&
    plan.p3QaVerdict?.blocking === true &&
    !plan.p3QaVerdict.decidedAt &&
    (plan.qaAutopilot === false ||
      ((plan.qaIntegratorRounds ?? 0) >= 1 && (plan.qaAutoFixRounds ?? 0) >= autofixMax))
  )
    return view('blocked', 'QA-EXHAUSTED: blocking verdict undecided, automation spent');

  //   (c) GRAPH-DEADLOCK: non-terminal blocked nodes with an empty frontier and
  //       nothing running (a failed dependency wedged its dependents).
  if (
    (status === 'developing' || status === 'fixing') &&
    storyNodes.length > 0 &&
    storyNodes.some((n) => n.state === 'blocked') &&
    !storyNodes.some((n) => RUNNING_STATES.includes(n.state))
  )
    return view('blocked', 'GRAPH-DEADLOCK: blocked nodes, empty frontier, nothing running');

  // 4. queued — accepted but nothing dispatched yet.
  if (status === 'concept') {
    const nothingProduced =
      storyNodes.length === 0 &&
      !plan.conceptPlan &&
      !plan.prdRequirementIds?.length &&
      !plan.conceptArtifacts?.some((a) => a.rev > 0);
    const plannedUndispatched =
      storyNodes.length > 0 &&
      storyNodes.every((n) => n.state === 'ready' || n.state === 'blocked');
    if (nothingProduced) return view('queued', 'accepted — no concept output emitted yet');
    if (plannedUndispatched)
      return view('queued', 'planSpec ingested — awaiting first daemon claim');

    // 5. concept — PRD/UX/arch generation, approve gates, or planner convergence.
    return view(
      'concept',
      'concept in flight (artifacts / PRD requirement ids / conceptPlan present)',
    );
  }

  // 6. developing — 'developing' or 'fixing' (both are truthfully development).
  if (status === 'developing' || status === 'fixing')
    return view(
      'developing',
      status === 'fixing'
        ? 'fix-stories after blocking QA'
        : 'stories in flight (claimed/developing/merging/verifying)',
      { devUrl: plan.devUrl },
    );

  // 7 & 8. review — deployed-app QA cycle (vqa) vs promote ladder (deployment).
  if (status === 'review') {
    if (!isDeliverable(plan))
      return view('vqa', 'deployed-app QA not yet verified (isDeliverable=false)', {
        devUrl: plan.devUrl,
      });

    // deployment — QA passed / operator-approved; remaining work is the promote ladder.
    const detail = !plan.stagingUrl
      ? 'awaiting staging promote'
      : !plan.deployUrl
        ? 'awaiting production promote'
        : 'production live — awaiting delivered mark';
    return view('deployment', detail, {
      devUrl: plan.devUrl,
      stagingUrl: plan.stagingUrl,
      deployUrl: plan.deployUrl,
    });
  }

  // default — surface, never fake progress.
  return view('blocked', `unknown-status '${status}'`);
}

// ─────────────────────────────────────────────────────────────────────────────
// Hono handlers — machine-callable, guarded by the x-queue-key shared secret.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Validate the `x-queue-key` shared secret exactly like the queue-ingest
 * handler. Fail-closed (401) when the env secret is unset OR the header is
 * missing/mismatched. Returns a Response on failure, `null` to proceed.
 */
function checkQueueKey(c: Context): Response | null {
  const expected = process.env.QUEUE_INGEST_SECRET;
  const provided = c.req.header('x-queue-key');
  if (!expected || !provided || provided !== expected) {
    return c.json(
      { error: { code: 'AUTH_REQUIRED', message: 'Invalid or missing x-queue-key' } },
      401,
    );
  }
  return null;
}

/** POST /api/pipeline/dispatch — external "intent → running P3 plan". */
export async function handleDispatch(c: Context): Promise<Response> {
  const unauth = checkQueueKey(c);
  if (unauth) return unauth;

  const body = await c.req.json().catch(() => ({}));
  const parsed = dispatchPipelineSchema.safeParse(body);
  if (!parsed.success)
    return c.json(
      {
        error: {
          code: 'VALIDATION_ERROR',
          message: parsed.error.issues.map((i) => i.message).join('; '),
        },
      },
      400,
    );

  const { source, intent, name } = parsed.data;
  try {
    const { planId, appId } = await createPipelineRunFromIntent({
      intent,
      name,
      createdBy: `external:${source}`,
    });
    return c.json(
      {
        runId: planId,
        appId,
        statusUrl: `/api/pipeline/runs/${planId}`,
        status: 'accepted',
      },
      202,
    );
  } catch (err) {
    // Relay repo/GitHub failures gracefully, exactly like quick-p3.
    if (err instanceof GitHubError)
      return c.json(
        { error: { code: 'GITHUB_ERROR', message: err.message } },
        (err.status === 401 ? 502 : err.status) as 400,
      );
    if (err instanceof AppError)
      return c.json({ error: { code: err.code, message: err.message } }, err.statusCode as 400);
    throw err;
  }
}

/** GET /api/pipeline/runs/:id — external stage poll for a dispatched run. */
export async function handleGetRun(c: Context): Promise<Response> {
  const unauth = checkQueueKey(c);
  if (unauth) return unauth;

  const planId = c.req.param('id');
  if (!planId) return c.json({ error: { code: 'NOT_FOUND', message: 'run id required' } }, 404);
  const plan = await planRepo.getPlanById(planId);
  if (!plan)
    return c.json({ error: { code: 'NOT_FOUND', message: `run '${planId}' not found` } }, 404);

  // Same reads GET /api/plans/:id and /story-nodes perform; never-ingested plans
  // return an empty array (not a 404).
  const storyNodes = await storyNodeRepo.getPlanStoryNodes(planId);
  return c.json(derivePipelineStage(plan, storyNodes));
}
