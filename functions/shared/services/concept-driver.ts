import type { Plan } from '../types/plan';
import type { AgentJob } from '../types/agent-orchestrator';
import type { BoilerplateType } from '../boilerplates/registry';
import type { ConceptArtifactKind, ConceptArtifactDepth } from '../concept/concept-plan';
import { reduceConcept } from './concept-reducer';
import { applyConceptArtifactOutput, artifactSourceFromJob } from './concept-artifact-service';
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
    const boilerplateType = await boilerplateOf(plan, deps);
    const pipeline = buildArtifactPipeline(plan, kind, boilerplateType);
    const jobId = deps.uuid();
    const ts = deps.now();
    await deps.createJob({
      jobId,
      status: 'PENDING',
      createdAt: ts,
      updatedAt: ts,
      createdBy: plan.createdBy,
      workingDir: plan.workingDir,
      pipeline,
      // Story 3.4 — markers so an orphaned RUNNING generator (daemon restart)
      // auto-requeues to PENDING instead of dead-ending at STALE. Autopilot
      // one-shots only; interactive convergence (E4) never sets these.
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
  // Dedup: a chain-driven pm-plan already enqueued short-circuits.
  if (plan.conceptPmPlanJobId) {
    const j = await deps.getJobById(plan.conceptPmPlanJobId);
    if (j && j.status !== 'FAILED') {
      return { kind: 'noop', reason: 'pm-plan already enqueued' };
    }
  }
  const boilerplateType = await boilerplateOf(plan, deps);
  const pmPipeline = generatePmPlanPipeline({
    planName: plan.name,
    intent: plan.intent,
    executionMode: plan.executionMode,
    devModel: plan.devModel,
    boilerplateType,
    rigor: plan.rigor ?? 'mvp',
    kind: plan.kind,
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
