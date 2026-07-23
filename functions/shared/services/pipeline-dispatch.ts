import { createHash } from 'node:crypto';

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
import { resolveRepoRef } from '../github/parse-repo-url';
import * as appRepo from '../repositories/app-repository';
import * as planRepo from '../repositories/plan-repository';
import * as agentJobsRepo from '../repositories/agent-jobs-repository';
import * as storyNodeRepo from '../repositories/story-node-repository';
import * as queueRequestsRepo from '../repositories/queue-requests-repository';
import type { QueueRequest, QueueRequestStatus } from '../types/queue-request';

/**
 * External pipeline-dispatch service (NEW machine-callable surface).
 *
 * An external `x-queue-key` caller (mycelium, etc.) POSTs a `seal` (a converged,
 * approved plan contract) — or a bare `intent` — and Futurator runs a full
 * Pipeline-3 dev run, tracked via GET /api/pipeline/runs/:id.
 *
 * Identity model (the whole point of v2):
 *   • app.ref → a DETERMINISTIC Futurator appId (`deriveAppId`). Unknown ref →
 *     GREENFIELD (scaffold a fresh repo, reuses the quick-p3 flow). Known ref →
 *     ITERATION (new Plan on the existing app + worktree, brownfield planner —
 *     mirrors the `POST /api/plans` targetAppId branch).
 *   • seal.id (+ version) → a DETERMINISTIC runId/planId (`deriveRunId`). A
 *     re-sent same seal+version is IDEMPOTENT (returns the existing run); a new
 *     version starts a NEW run (re-develop). No seal → random id, no dedup.
 *   • seal/version/app.ref/git are stamped onto the Plan as `sealProvenance`
 *     and echoed by the status endpoint. `git` is provenance ONLY in v1
 *     (recorded, not cloned — Futurator owns the dev repo).
 *   • dependsOn/priorPlan (C4) — OPTIONAL, ADVISORY ONLY. Also stamped onto
 *     `sealProvenance` and echoed by the status endpoint, but never read by
 *     any admission or frontier-scheduling code path. C1 (same-app
 *     precedence at the daemon frontier, `agent-daemon.mjs`) is the sole
 *     authoritative ordering gate; this field exists so a caller with
 *     CROSS-APP ordering knowledge (which C1's same-app check can't see) can
 *     express and round-trip it for correlation.
 *
 * `createdBy` carries the caller (`external:<source>`) — there is no JWT user,
 * exactly how the queue-ingest path stamps `createdBy: 'external'`.
 */

// ─────────────────────────────────────────────────────────────────────────────
// Deterministic identity — appId from (source, ref); runId from (source, seal).
// ─────────────────────────────────────────────────────────────────────────────

function slugify(s: string, max = 30): string {
  const base = s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, max);
  return base || 'app';
}

function shortHash(s: string, n = 6): string {
  return createHash('sha256').update(s).digest('hex').slice(0, n);
}

/**
 * Deterministic, human-readable Futurator appId for a caller's stable app ref.
 * STABLE across seals (depends only on source+ref, never on the display name),
 * kebab, letter-first, ≤40 chars, collision-safe via a short content hash.
 */
export function deriveAppId(source: string, ref: string): string {
  let id = `${slugify(ref, 30)}-${shortHash(`${source}:${ref}`)}`.slice(0, 40);
  if (!/^[a-z]/.test(id)) id = `a${id}`.slice(0, 40);
  return id;
}

/**
 * Deterministic UUID-shaped runId/planId for a (source, sealId, version). Same
 * seal+version → same id (idempotent); a new version → a new id (new run).
 */
export function deriveRunId(source: string, sealId: string, version?: string): string {
  const h = createHash('sha256')
    .update(`${source}:seal:${sealId}:${version ?? ''}`)
    .digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
}

/**
 * Public https URL of the app's dev repo. Brownfield apps carry an explicit
 * `githubRepoUrl`; greenfield falls back to `futurator-repos/<appId>` (the repo
 * the dispatch scaffold creates). Exposed so external callers (mycelium) can
 * store the project→repo binding from the first run.
 */
export function repoHtmlUrl(appId: string, githubRepoUrl?: string | null): string {
  const { owner, repo } = resolveRepoRef(appId, githubRepoUrl);
  return `https://github.com/${owner}/${repo}`;
}

/** Throwaway per-call slug when the caller supplies no stable app.ref. */
function throwawaySlug(seedText: string): string {
  const base = slugify(seedText, 24);
  return `${base.replace(/^[^a-z]/, 'q')}-${crypto.randomUUID().slice(0, 6)}`.slice(0, 40);
}

// ─────────────────────────────────────────────────────────────────────────────
// Dispatch — resolve identity, then greenfield-scaffold or iterate.
// ─────────────────────────────────────────────────────────────────────────────

export type DispatchInput = z.infer<typeof dispatchPipelineSchema>;

export interface DispatchResult {
  runId: string;
  appId: string;
  /** true when this dispatch created the app (greenfield); false = iteration. */
  isNewApp: boolean;
  /** true when the seal+version was already dispatched — existing run returned. */
  idempotent: boolean;
  /**
   * C2 — true when admitted behind a still-in-flight same-app predecessor. The
   * plan is created but held (`concept`, generation deferred). Honest status is
   * `queued`, never a silent concurrent `developing`.
   */
  held: boolean;
  /** planId of the same-app predecessor this dispatch is held behind (C2). */
  heldBehind?: string;
}

/**
 * Local widening of the shared `Plan['sealProvenance']` shape to also carry
 * the C4 advisory ordering field. `dependsOn` is deliberately NOT added to
 * the shared `Plan` type (out of this fix's file scope) — TS structural
 * typing allows a value with extra optional properties to flow into the
 * narrower `Plan.sealProvenance` field on assignment (no excess-property
 * check applies to a variable, only to a fresh object literal), and at
 * runtime/JSON the extra key is simply present and round-trips through
 * `GET /api/pipeline/runs/:id`'s existing `provenance: plan.sealProvenance`
 * echo untouched.
 */
type SealProvenance = NonNullable<Plan['sealProvenance']> & {
  /**
   * C4 — ADVISORY ONLY. Opaque prior seal ids / runIds. Never read by any
   * admission or frontier-scheduling code path — C1's same-app precedence
   * check at the frontier remains the sole authoritative gate. Present only
   * when the caller supplied `dependsOn` and/or `priorPlan`.
   */
  dependsOn?: string[];
  /**
   * C2 — ADMISSION-TIME HONEST-STATUS MARKER (thin). Set to the planId of the
   * earliest non-terminal SAME-APP predecessor when this plan was admitted
   * while that predecessor was still in flight. The plan is still created
   * (202) but stays `concept` with its generation job deferred, so it cannot
   * silently develop concurrently; `derivePipelineStage` reads this to report
   * an honest held/`queued` status instead. Keyed on appId + predecessor
   * plan-status ONLY — no app content. Round-trips through the status echo so
   * the caller sees WHICH predecessor it waits on. NOT a scheduler: release of
   * a held plan (creating its deferred generation job once the predecessor is
   * terminal) is deferred to O-6; C1's frontier gate is the authoritative
   * backstop for any held plan that does carry stories.
   */
  heldBehind?: string;
};

/**
 * Resolve identity + dispatch. Reuses the quick-p3 create flow for greenfield
 * and the `POST /api/plans` targetAppId branch for iteration.
 */
export async function dispatchPipelineRun(input: DispatchInput): Promise<DispatchResult> {
  const { source } = input;
  const document = input.seal?.document ?? input.intent!;
  const createdBy = `external:${source}`;
  const now = new Date().toISOString();

  // C4 — advisory dependency ordering. `priorPlan` (a structured {sealId,
  // version} predecessor reference) resolves to a runId via the SAME
  // deterministic `deriveRunId` used for idempotency — no mapping table
  // needed. It is folded into the caller's raw `dependsOn` list (opaque ids,
  // never interpreted). Both are stamped verbatim; neither is consulted by
  // any admission/frontier code in this file — C1's same-app precedence
  // check at the frontier remains the sole authoritative gate.
  const priorPlanRunId = input.priorPlan
    ? deriveRunId(source, input.priorPlan.sealId, input.priorPlan.version)
    : undefined;
  const dependsOn = [...(input.dependsOn ?? []), ...(priorPlanRunId ? [priorPlanRunId] : [])];

  const provenance: SealProvenance = {
    source,
    ...(input.app?.ref ? { appRef: input.app.ref } : {}),
    ...(input.seal?.id ? { sealId: input.seal.id } : {}),
    ...(input.seal?.version ? { sealVersion: input.seal.version } : {}),
    ...(input.git ? { git: input.git } : {}),
    ...(dependsOn.length ? { dependsOn } : {}),
    dispatchedAt: now,
  };

  const hasAppRef = Boolean(input.app?.ref);
  const hasSeal = Boolean(input.seal?.id);

  // Deterministic ids (or random for the simple, identity-less path).
  const appId = hasAppRef
    ? deriveAppId(source, input.app!.ref)
    : throwawaySlug(input.app?.name || input.name || document);
  const runId = hasSeal
    ? deriveRunId(source, input.seal!.id, input.seal!.version)
    : crypto.randomUUID();

  // Idempotency — a seal already dispatched at this version returns its run.
  if (hasSeal) {
    const existing = await planRepo.getPlanById(runId);
    if (existing) {
      return {
        runId,
        appId: existing.appId ?? appId,
        isNewApp: false,
        idempotent: true,
        held: false,
      };
    }
  }

  // App resolution — known ref iterates; unknown ref (or no ref) is greenfield.
  const existingApp = hasAppRef ? await appRepo.getApp(appId) : null;

  if (existingApp) {
    // C2 — admission-time honest "held" check (thin, NOT a scheduler). If an
    // earlier same-app plan is still non-terminal, admit this plan but HOLD it:
    // keep it `concept`, defer its generation job, and mark it so the status
    // endpoint reports an honest `queued` (held) stage rather than a silent
    // concurrent `developing` plan. Keyed on appId + predecessor plan-status
    // ONLY — never on app/seal content. A brand-new (greenfield) app has no
    // predecessor, so this only fires on the iteration path. Release of a held
    // plan is deferred (O-6); C1's frontier gate is the authoritative backstop.
    const predecessor = await planRepo.getActivePlanForApp(appId);
    const heldBehind = predecessor?.planId;
    if (heldBehind) provenance.heldBehind = heldBehind;
    await createIterationPlan({
      app: existingApp,
      runId,
      document,
      provenance,
      createdBy,
      now,
      held: Boolean(heldBehind),
    });
    return {
      runId,
      appId,
      isNewApp: false,
      idempotent: false,
      held: Boolean(heldBehind),
      heldBehind,
    };
  }

  const displayName = input.app?.name || input.name;
  const created = await createGreenfieldRun({
    appId,
    displayName,
    runId,
    document,
    provenance,
    createdBy,
    now,
    boilerplateType: input.boilerplateType,
  });
  // Greenfield creates a brand-new app — no same-app predecessor can exist, so a
  // greenfield dispatch is never held (C2 is an iteration-only concern).
  return { runId, appId: created.appId, isNewApp: true, idempotent: false, held: false };
}

/**
 * GREENFIELD — scaffold a fresh app repo, then plan + planspec (faithful copy of
 * quick-p3, but with a caller-chosen appId, planId=runId, and provenance).
 */
async function createGreenfieldRun(args: {
  appId: string;
  displayName?: string;
  runId: string;
  document: string;
  provenance: SealProvenance;
  createdBy: string;
  now: string;
  /** Caller-declared scaffold template; absent/unknown → neutral base. */
  boilerplateType?: string;
}): Promise<{ appId: string }> {
  const { appId, displayName, runId, document, provenance, createdBy, now } = args;
  const base = displayName ? slugify(displayName, 24) : appId;

  // Scaffold template: honor the caller-declared `boilerplateType` when it names
  // a known registry template; otherwise fall back to the NEUTRAL base — NOT a
  // domain-specific (e.g. game) literal. Template inference from the NL intent is
  // a deferred enhancement (O-8); the dispatch path never guesses a domain here.
  const requested = normalizeBoilerplateType(args.boilerplateType);
  const boilerplateType: BoilerplateType = BOILERPLATE_REGISTRY[requested]
    ? requested
    : 'nextjs-base';
  const meta = BOILERPLATE_REGISTRY[boilerplateType];

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

  const plan: Plan = {
    planId: runId,
    name: appId,
    displayName: `${base} — dispatch`,
    intent: document,
    description: '',
    status: 'concept',
    epicIds: [],
    kind: 'initial',
    appId,
    workingDir: app.workingDir,
    executionMode: 'pipeline',
    rigor: 'mvp',
    totalCostUsd: 0,
    totalStories: 0,
    doneStories: 0,
    costCeilingUsd: defaultCostCeiling('mvp'),
    qaAutopilot: true,
    qaAutoFixRounds: 0,
    sealProvenance: provenance,
    createdAt: now,
    updatedAt: now,
    createdBy,
  };
  await planRepo.createPlan(plan);

  // The generation job — waits for the scaffold, then one Claude call → StoryNodes.
  await agentJobsRepo.createJob({
    jobId: crypto.randomUUID(),
    status: 'PENDING',
    createdAt: now,
    updatedAt: now,
    createdBy,
    workingDir: app.workingDir,
    jobType: 'quick-planspec',
    quickPlanspecPayload: {
      planId: runId,
      appId,
      intent: document,
      appBootstrapJobId: bootstrapJobId,
      seamHook: meta.testHarness?.seamHook,
    },
  });

  return { appId };
}

/**
 * ITERATION — a new seal on an EXISTING app: new Plan on the existing worktree,
 * brownfield planner (no scaffold). Mirrors the `POST /api/plans` targetAppId
 * branch. planId=runId; provenance stamped.
 */
async function createIterationPlan(args: {
  app: App;
  runId: string;
  document: string;
  provenance: SealProvenance;
  createdBy: string;
  now: string;
  /**
   * C2 — when true, an earlier same-app plan is still non-terminal. Admit this
   * plan (row created) but DEFER its generation job so it stays `concept` and
   * cannot silently develop concurrently. `provenance.heldBehind` carries the
   * predecessor id; `derivePipelineStage` reports the honest held/`queued`
   * status. Creating the deferred job on predecessor-terminal is O-6 (deferred).
   */
  held?: boolean;
}): Promise<void> {
  const { app, runId, document, provenance, createdBy, now, held } = args;
  const bpType = normalizeBoilerplateType(app.boilerplateType || 'nextjs-base');
  const seamHook = BOILERPLATE_REGISTRY[bpType]?.testHarness?.seamHook;

  // Deterministic, non-colliding plan name per seal (createPlan enforces name
  // uniqueness; the idempotent short-circuit above means this only runs once).
  const nameSuffix = provenance.sealId
    ? `seal-${shortHash(`${provenance.sealId}:${provenance.sealVersion ?? ''}`)}`
    : `change-${runId.slice(0, 5)}`;

  const plan: Plan = {
    planId: runId,
    name: `${app.appId}-${nameSuffix}`,
    displayName: `${app.displayName ?? app.appId} — ${provenance.sealVersion ?? 'change'}`,
    intent: document,
    description: '',
    status: 'concept',
    epicIds: [],
    kind: 'change',
    appId: app.appId,
    workingDir: app.workingDir,
    executionMode: 'pipeline',
    rigor: 'mvp',
    totalCostUsd: 0,
    totalStories: 0,
    doneStories: 0,
    costCeilingUsd: defaultCostCeiling('mvp'),
    qaAutopilot: true,
    qaAutoFixRounds: 0,
    sealProvenance: provenance,
    createdAt: now,
    updatedAt: now,
    createdBy,
  };
  await planRepo.createPlan(plan);

  // C2 — HELD: an earlier same-app plan is still non-terminal. Admit this plan
  // (row created above, stays `concept`) but DEFER its generation job so it
  // cannot silently begin developing concurrently. `derivePipelineStage` reads
  // `provenance.heldBehind` and reports an honest held/`queued` status. Creating
  // this deferred job once the predecessor is terminal is a release sweep,
  // explicitly out of the thin MVP (O-6). Keyed purely on predecessor status.
  if (held) return;

  // Generation job — no scaffold to wait for (existing worktree), so no
  // appBootstrapJobId; `brownfield: true` → planner plans against real code.
  // Built as a variable so the extra `brownfield` key isn't excess-property-
  // checked against quickPlanspecPayload's type (the daemon reads it at runtime).
  const quickPlanspecPayload = {
    planId: runId,
    appId: app.appId,
    intent: document,
    seamHook,
    brownfield: true,
  };
  await agentJobsRepo.createJob({
    jobId: crypto.randomUUID(),
    status: 'PENDING',
    createdAt: now,
    updatedAt: now,
    createdBy,
    workingDir: app.workingDir,
    jobType: 'quick-planspec',
    quickPlanspecPayload,
  });
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
    // C2 — HELD behind a same-app predecessor. Admitted (202) but deferred: the
    // plan stays `concept` with no generation job, so it reports an honest
    // `queued` (held) stage — never a silent concurrent `developing`. Read the
    // marker stamped at admission; keyed only on that marker + plan-status, no
    // app content. Reuses the existing `queued` stage (no new stage value).
    const heldBehind = (plan.sealProvenance as SealProvenance | undefined)?.heldBehind;
    if (heldBehind)
      return view(
        'queued',
        `held — same-app predecessor '${heldBehind}' non-terminal (awaiting precedence release)`,
      );

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

// ─────────────────────────────────────────────────────────────────────────────
// A2 — sanitized header capture (secret stripped, mirrors the ingest contract).
// ─────────────────────────────────────────────────────────────────────────────

/** Header names never persisted — case-insensitive, generic (not caller-specific). */
const SECRET_HEADER_NAMES = new Set(['x-queue-key', 'authorization']);

/**
 * Snapshot every inbound header as a plain object, with secret-bearing headers
 * stripped. App-agnostic: copies whatever the caller sent verbatim (lower-cased
 * names, Headers' own iteration order) except the two denylisted names — no
 * allow-list, no caller/app-specific handling.
 */
function sanitizeHeaders(c: Context): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of c.req.raw.headers.entries()) {
    if (SECRET_HEADER_NAMES.has(name.toLowerCase())) continue;
    out[name] = value;
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// A1 — audit-only queue-request row per inbound dispatch (visible in /queues).
// ─────────────────────────────────────────────────────────────────────────────

/** 30-day TTL on the audit row's `expiresAt`, mirroring the ingest path. */
const QUEUE_REQUEST_TTL_SECONDS = 30 * 24 * 60 * 60;

/**
 * Map an external pipeline stage → the coarse queue-request status vocabulary
 * (the audit row's display status). Keys ONLY on the stage enum — no app/seal
 * content — so it stays app-agnostic. A read-side join (A4) may re-derive live
 * from the linked plan; `dispatchStage` on the row carries the exact stage.
 */
function dispatchStageToRequestStatus(stage: PipelineStage): QueueRequestStatus {
  switch (stage) {
    case 'completed':
      return 'COMPLETED';
    case 'failed':
      return 'FAILED';
    case 'queued':
      return 'QUEUED';
    default:
      // concept | developing | vqa | deployment | blocked → still in flight.
      return 'RUNNING';
  }
}

/**
 * Write ONE audit-only `queue-requests` row for an inbound dispatch so the
 * pipeline-dispatch/frontier path is visible in `/development/queues` alongside
 * ingest rows. It does NOT spawn a queue-request agent-job — it only links to
 * the created run/plan (`runId`/`planId`, which share one id on this path) and
 * carries an honest display status derived from the linked plan/stage.
 *
 * App-agnostic: a generic `{source, kind, runId, planId, body, headers, status}`
 * envelope — persists whatever the caller sent (raw parsed JSON body, verbatim,
 * no field allow-list) plus sanitized headers, with NO seal-/app-specific
 * columns and no hardcoded provider/target. Best-effort: a write failure never
 * fails the dispatch (the run is already created) — the caller logs and
 * continues.
 *
 * `rawBody` is the body exactly as `c.req.json()` parsed it — NOT `parsed.data`
 * (zod's `.safeParse` output), which can drop unknown keys / apply defaults.
 * Storing the raw object satisfies the A2 AC: re-serializing it reproduces the
 * request body byte-for-byte (modulo key ordering).
 */
async function writeDispatchAuditRow(
  c: Context,
  rawBody: unknown,
  input: DispatchInput,
  result: DispatchResult,
): Promise<void> {
  const { runId } = result;
  const now = new Date().toISOString();

  // Honest display status: derive from the linked plan/stage. For a just-minted
  // plan this is 'queued'/'concept'; for the idempotent path it reflects wherever
  // the plan is now. Never let stage resolution break the audit write.
  let stage: PipelineStage = 'queued';
  try {
    const plan = await planRepo.getPlanById(runId);
    if (plan) {
      const storyNodes = await storyNodeRepo.getPlanStoryNodes(runId);
      stage = derivePipelineStage(plan, storyNodes).stage;
    }
  } catch {
    // fall back to 'queued'
  }

  const document = input.seal?.document ?? input.intent ?? '';
  const createdBy = `external:${input.source}`;
  const row: QueueRequest = {
    requestId: crypto.randomUUID(),
    status: dispatchStageToRequestStatus(stage),
    kind: 'dispatch',
    source: input.source,
    receiver: input.source,
    // No declared `target`: the dispatch/frontier path resolves the executing
    // host from the minted job's assignedServerId (A4), never a provider literal.
    method: c.req.method,
    path: c.req.path,
    headers: sanitizeHeaders(c), // secret stripped — mirrors the ingest contract.
    body: rawBody, // exact inbound JSON, verbatim — no field allow-list.
    prompt: document, // the received order handed to the pipeline
    autoRespond: false,
    runId,
    planId: runId, // planId === runId on the dispatch path
    dispatchStage: stage,
    createdAt: now,
    updatedAt: now,
    audit: [
      {
        at: now,
        event: 'dispatched',
        by: createdBy,
        detail: `runId=${runId} planId=${runId} appId=${result.appId} stage=${stage} (isNewApp=${result.isNewApp}, idempotent=${result.idempotent})`,
      },
    ],
    createdBy,
    expiresAt: Math.floor(Date.now() / 1000) + QUEUE_REQUEST_TTL_SECONDS,
  };

  await queueRequestsRepo.createRequest(row);
}

/** POST /api/pipeline/dispatch — external "seal/intent → running P3 plan". */
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

  try {
    const dispatchResult = await dispatchPipelineRun(parsed.data);
    const { runId, appId, isNewApp, idempotent, held, heldBehind } = dispatchResult;
    // A1 — record one audit-only queue-request row so this dispatch shows up in
    // /development/queues, linked to its run/plan. Best-effort: a failure here
    // must not fail an already-created run.
    try {
      await writeDispatchAuditRow(c, body, parsed.data, dispatchResult);
    } catch (auditErr) {
      console.error('[pipeline-dispatch] audit-row write failed', auditErr);
    }
    // Repo binding for the caller — the app row exists by now on every path
    // (greenfield creates it before returning; iteration/idempotent found it).
    const app = await appRepo.getApp(appId);
    return c.json(
      {
        runId,
        appId,
        repoUrl: repoHtmlUrl(appId, app?.githubRepoUrl),
        isNewApp,
        idempotent,
        // C2 — honest admission status. A plan admitted behind a still-in-flight
        // same-app predecessor is 'held' (created, but `concept` + generation
        // deferred → reported as `queued`), never a silent concurrent developer.
        // Poll `statusUrl` for the live stage; `heldBehind` names the blocker.
        held,
        ...(heldBehind ? { heldBehind } : {}),
        statusUrl: `/api/pipeline/runs/${runId}`,
        status: held ? 'held' : 'accepted',
      },
      // 202 for a fresh dispatch (held or not); 200 when the seal was already
      // dispatched. A held plan is still accepted — the caller can retry the
      // status poll rather than being refused with a 409.
      idempotent ? 200 : 202,
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
  const view = derivePipelineStage(plan, storyNodes);
  const app = plan.appId ? await appRepo.getApp(plan.appId) : null;
  // Echo dispatch provenance so the caller can correlate this run to its
  // seal. `plan.sealProvenance` carries whatever was actually stamped at
  // admission — including C4's advisory `dependsOn` when the dispatch
  // supplied it — so it round-trips here with no extra handling needed.
  return c.json({
    runId: planId,
    appId: plan.appId,
    ...(plan.appId ? { repoUrl: repoHtmlUrl(plan.appId, app?.githubRepoUrl) } : {}),
    provenance: plan.sealProvenance,
    ...view,
  });
}
