import type { Plan } from '../types/plan';
import type { AgentJob } from '../types/agent-orchestrator';
import type { BoilerplateType } from '../boilerplates/registry';
import type { ConceptArtifactKind, ConceptArtifactDepth } from '../concept/concept-plan';
import { reduceConcept } from './concept-reducer';
import {
  applyConceptArtifactOutput,
  artifactSourceFromJob,
  requirementIdsFromJob,
} from './concept-artifact-service';
import { resolveConceptInteraction } from './resolve-concept-interaction';
import { generatePrdGenPipeline } from '../pipelines/prd-gen-pipeline';
import { generateUxGenPipeline } from '../pipelines/ux-gen-pipeline';
import { generateArchGenPipeline } from '../pipelines/arch-gen-pipeline';
import { generatePmPlanPipeline } from '../pipelines/pm-plan-pipeline';

/**
 * Concept v2 (E3 / Story 3.2) — the Concept driver.
 *
 * Turns the pure reducer's decision (Story 3.1) into real enqueues, server-side,
 * under the per-plan reduce lock (the caller holds it). It does two things each
 * pass, idempotently:
 *
 *   1. APPLY completed generators — for any artifact whose generator job is
 *      COMPLETED, register its output on the Plan row (apply-service, E1.3) and,
 *      in autopilot, auto-approve. Idempotent: re-apply of identical content is a
 *      no-op. This is the "no frontend click" guarantee — a closed browser never
 *      wedges the DAG (the cron backstop drives it).
 *   2. ENQUEUE the next step — run `reduceConcept` on the freshly-applied plan
 *      and create exactly one job (next artifact generator, or the chain-driven
 *      pm-plan), stamping the FK. Never double-enqueues: an in-flight FK
 *      (PENDING/RUNNING) for the same artifact short-circuits.
 *
 * Both the reactive apply endpoints (E2.4) and the wave-completion cron call this
 * — the lock serializes them so exactly one next job is created.
 *
 * The Lambda builds pipelines WITHOUT inlined `priorArtifacts`; the daemon fills
 * `{{PRIOR_ARTIFACTS}}` from the approved on-disk manifests at run time (Story
 * 3.2a). Prototype/legacy plans (no conceptPlan) are a no-op here — the v1
 * eager-pm-plan path owns them (W8).
 */

const FK_FIELD: Record<ConceptArtifactKind, 'prdGenJobId' | 'uxGenJobId' | 'archGenJobId'> = {
  prd: 'prdGenJobId',
  ux: 'uxGenJobId',
  architecture: 'archGenJobId',
};

export interface ConceptDriverDeps {
  getPlanById: (planId: string) => Promise<Plan | null>;
  getJobById: (jobId: string) => Promise<AgentJob | null>;
  createJob: (job: AgentJob) => Promise<unknown>;
  updatePlanFields: (planId: string, patch: Partial<Plan>) => Promise<void>;
  getApp: (appId: string) => Promise<{ boilerplateType?: string } | null>;
  uuid: () => string;
  now: () => string;
}

export type ConceptDriveResult =
  | { kind: 'noop'; reason: string }
  | { kind: 'awaiting-approval'; artifact: ConceptArtifactKind }
  | { kind: 'skip-inflight'; artifact: ConceptArtifactKind; jobId: string }
  | { kind: 'enqueued-artifact'; artifact: ConceptArtifactKind; jobId: string }
  | { kind: 'enqueued-convergence'; artifact: ConceptArtifactKind; jobId: string }
  | { kind: 'enqueued-pm-plan'; jobId: string };

function depthFor(plan: Plan, kind: ConceptArtifactKind): ConceptArtifactDepth {
  return plan.conceptPlan?.artifacts.find((a) => a.kind === kind)?.depth ?? 'lite';
}

async function boilerplateOf(plan: Plan, deps: ConceptDriverDeps): Promise<BoilerplateType> {
  const app = plan.appId ? await deps.getApp(plan.appId) : null;
  return (app?.boilerplateType ?? 'nextjs-base') as BoilerplateType;
}

/** Apply every COMPLETED generator's output onto the plan row (idempotent). */
async function applyCompletedGenerators(plan: Plan, deps: ConceptDriverDeps): Promise<void> {
  if (!plan.conceptPlan) return;
  const autoApprove = resolveConceptInteraction(plan) === 'autopilot';
  for (const a of plan.conceptPlan.artifacts) {
    const fk = plan.conceptArtifactJobIds?.[a.kind] ?? plan[FK_FIELD[a.kind]];
    if (!fk) continue;
    const job = await deps.getJobById(fk);
    if (!job || job.status !== 'COMPLETED') continue;
    try {
      const source = artifactSourceFromJob(job, a.kind);
      await applyConceptArtifactOutput(plan, a.kind, source, {
        updatePlanFields: deps.updatePlanFields,
        autoApprove,
      });
      // v3 E1-S2 — stamp the PRD's FR-id coverage ground truth (captured by the
      // daemon write-back) so the readiness gate can enforce epic coverage.
      if (a.kind === 'prd') {
        const reqIds = requirementIdsFromJob(job);
        if (reqIds) await deps.updatePlanFields(plan.planId, { prdRequirementIds: reqIds });
      }
    } catch {
      // Defensive: a generator job with no usable output — leave it; the next
      // tick (or a regenerate) recovers. Never throw out of the driver.
    }
  }
}

// The daemon-fill placeholder (Story 3.2a): the Lambda enqueues ux/arch with
// this token; the daemon substitutes the approved upstream section bodies from
// disk at run time. PRD is the chain head — no upstream, no placeholder.
const PRIOR_ARTIFACTS_PLACEHOLDER = '{{PRIOR_ARTIFACTS}}';

function buildArtifactPipeline(
  plan: Plan,
  kind: ConceptArtifactKind,
  boilerplateType: BoilerplateType,
) {
  const common = {
    intent: plan.intent,
    boilerplateType,
    rigor: plan.rigor ?? 'mvp',
    depth: depthFor(plan, kind),
  };
  if (kind === 'prd') return generatePrdGenPipeline(common);
  if (kind === 'ux') {
    return generateUxGenPipeline({ ...common, priorArtifacts: PRIOR_ARTIFACTS_PLACEHOLDER });
  }
  return generateArchGenPipeline({
    ...common,
    uiBearing: plan.conceptPlan?.uiBearing ?? false,
    priorArtifacts: PRIOR_ARTIFACTS_PLACEHOLDER,
  });
}

/**
 * Run one drive pass for a plan. The caller MUST hold the per-plan reduce lock.
 */
export async function driveConcept(
  planInput: Plan,
  deps: ConceptDriverDeps,
): Promise<ConceptDriveResult> {
  if (!planInput.conceptPlan) return { kind: 'noop', reason: 'no conceptPlan (prototype/legacy)' };

  // 1. Apply any completed generators, then re-read to get the post-apply registry.
  await applyCompletedGenerators(planInput, deps);
  const plan = (await deps.getPlanById(planInput.planId)) ?? planInput;

  // 2. Decide the next step.
  const action = reduceConcept(plan);
  if (action.type === 'noop') return { kind: 'noop', reason: action.reason };
  if (action.type === 'awaiting-approval') {
    return { kind: 'awaiting-approval', artifact: action.kind };
  }

  if (action.type === 'enqueue-artifact') {
    const kind = action.kind;
    // Dedup: an in-flight generator for this kind short-circuits.
    const fk = plan.conceptArtifactJobIds?.[kind] ?? plan[FK_FIELD[kind]];
    if (fk) {
      const j = await deps.getJobById(fk);
      if (j && (j.status === 'PENDING' || j.status === 'RUNNING')) {
        return { kind: 'skip-inflight', artifact: kind, jobId: fk };
      }
    }
    const jobId = deps.uuid();
    const ts = deps.now();

    // Round 1 (2026-06-17) — BOTH autopilot and interactive enqueue the SAME
    // one-shot generator pipeline, which runs in the PLAN worktree and writes
    // `concept/<kind>.md` (the writeback the autopilot path already uses). The
    // ONLY difference is approval, owned downstream by `applyCompletedGenerators`:
    //   • autopilot   → auto-approves the artifact, chain auto-advances;
    //   • interactive → applies it as a DRAFT, so `reduceConcept` returns
    //     `awaiting-approval` and pauses for the operator's Approve
    //     (POST /api/plans/:id/concept/:kind/approve) before advancing.
    // This replaces the prior dead-end `conceptConvergence` job (nothing in the
    // daemon consumed it → the chain stalled at PRD, docs never generated). The
    // multi-turn convergence CHAT (Round 2) will refine this draft in-place
    // before approval; the draft + plan-worktree model is its foundation.
    const boilerplateType = await boilerplateOf(plan, deps);
    const pipeline = buildArtifactPipeline(plan, kind, boilerplateType);
    await deps.createJob({
      jobId,
      status: 'PENDING',
      createdAt: ts,
      updatedAt: ts,
      createdBy: plan.createdBy,
      workingDir: plan.workingDir,
      pipeline,
      // Story 3.4 — markers so an orphaned RUNNING generator (daemon restart)
      // auto-requeues to PENDING instead of dead-ending at STALE. Set for BOTH
      // modes now (Round 1): a one-shot draft-gen is just as safe to requeue as
      // an autopilot gen — both re-derive the same `concept/<kind>.md`.
      conceptArtifactKind: kind,
      conceptAutopilotGen: true,
    } as unknown as AgentJob);
    await deps.updatePlanFields(plan.planId, {
      [FK_FIELD[kind]]: jobId,
      conceptArtifactJobIds: { ...(plan.conceptArtifactJobIds ?? {}), [kind]: jobId },
    });
    return { kind: 'enqueued-artifact', artifact: kind, jobId };
  }

  // action.type === 'enqueue-pm-plan' — all artifacts approved.
  // Dedup: a chain-driven pm-plan already enqueued short-circuits — but ONLY
  // when its output is still usable. A pm-plan can COMPLETE (status COMPLETED,
  // not FAILED) yet emit no parseable PLAN_JSON — e.g. the model overflows the
  // CLI output cap (CLAUDE_CODE_MAX_OUTPUT_TOKENS) before closing the fence, so
  // apply rejects it and the plan keeps zero epics. The old guard treated that
  // COMPLETED-but-empty job as "done" and the plan was stranded forever (no UI
  // re-run path for a concept-chain plan). So: short-circuit only while the job
  // is in-flight, OR it is terminal AND actually produced epics. Otherwise fall
  // through and re-enqueue a fresh grounded pm-plan (the cron re-fires this).
  if (plan.conceptPmPlanJobId) {
    const j = await deps.getJobById(plan.conceptPmPlanJobId);
    const planHasEpics = (plan.epicIds ?? []).length > 0;
    // In-flight = the prior pm-plan is still PENDING/RUNNING (don't double-enqueue).
    const inFlight = !!j && (j.status === 'PENDING' || j.status === 'RUNNING');
    // Noop only if the plan already has epics, or a pm-plan is currently running.
    // A terminal pm-plan that yielded NO epics (overflow/reject) falls through.
    if (j && (planHasEpics || inFlight)) {
      return { kind: 'noop', reason: 'pm-plan already enqueued' };
    }
  }
  // D4 (2026-06-22) — COMPACT RETRY. Reaching here with a prior pm-plan job set
  // means that attempt was TERMINAL-but-empty (it produced no epics — the
  // CLAUDE_CODE_MAX_OUTPUT_TOKENS overflow / mid-JSON truncation, or a reject).
  // Re-firing the identical prompt would just overflow identically, so we run
  // the re-generation in COMPACT mode (tighter ceilings + brevity directive)
  // to deterministically aim for a smaller, closeable plan. Cures the
  // re-overflow the cap-raise alone only mitigated.
  const isCompactRetry = !!plan.conceptPmPlanJobId;
  const boilerplateType = await boilerplateOf(plan, deps);
  const pmPipeline = generatePmPlanPipeline({
    planName: plan.name,
    intent: plan.intent,
    executionMode: plan.executionMode,
    devModel: plan.devModel,
    boilerplateType,
    rigor: plan.rigor ?? 'mvp',
    kind: plan.kind,
    // E5.1 — the chain-driven pm-plan always cites real sections; the daemon
    // fills {{CITABLE_SECTIONS}} from the approved manifests on disk (Story 5.2).
    expectsCitations: true,
    // Round 1.1 — and it PLANS FROM the approved docs: the daemon inlines the
    // full PRD/UX/Architecture bodies into {{PRIOR_ARTIFACTS}} at run time, so
    // the PM shards the specs into epics/stories instead of re-deriving scope
    // from the bare intent (the "planner ignored the docs" fix).
    priorArtifacts: PRIOR_ARTIFACTS_PLACEHOLDER,
    // D4 — re-fire smaller after a terminal-empty (overflow) prior attempt.
    compact: isCompactRetry,
  });
  const jobId = deps.uuid();
  const ts = deps.now();
  await deps.createJob({
    jobId,
    status: 'PENDING',
    createdAt: ts,
    updatedAt: ts,
    createdBy: plan.createdBy,
    workingDir: plan.workingDir,
    pipeline: pmPipeline,
  } as unknown as AgentJob);
  await deps.updatePlanFields(plan.planId, { conceptPmPlanJobId: jobId });
  return { kind: 'enqueued-pm-plan', jobId };
}
