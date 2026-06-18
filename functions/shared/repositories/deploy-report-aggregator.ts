/**
 * Deploy report aggregator — pure function that composes a plan-wide
 * DeployReport from plan + epics + fetched agent jobs + QA report.
 *
 * Verdict decision:
 *   never-deployed: no deploy jobs on record → can deploy if QA is ready
 *   not-ready:      QA verdict is `blocking` / `needs-attention` → can't ship
 *   deploying:      most recent deploy job is PENDING/RUNNING
 *   failed:         most recent deploy job FAILED
 *   live:           most recent deploy job COMPLETED successfully
 *   ready:          QA green + at least one successful deploy exists and the
 *                   operator is poised to re-deploy
 *
 * "live" vs "ready": if the most recent deploy COMPLETED and QA is still
 * ready, we render `live` so the operator sees the release is live. If they
 * want to re-deploy they can still do it from the live state.
 */

import type { AgentJob } from '../types/agent-orchestrator';
import type { EpicWorkflow } from '../types/epic-workflow';
import type { Plan } from '../types/plan';
import type {
  DeployEnvironmentStatus,
  DeployHandoff,
  DeployRecord,
  DeployReport,
  DeployStepStatus,
  DeployTarget,
  DeployVerdict,
} from '../types/deploy-report';
import type { QaReport } from '../types/qa-report';
import { resolveDeployTarget } from '../deploy/deploy-targets';

export interface DeployAggregatorInputs {
  plan: Plan;
  epics: EpicWorkflow[];
  /** Deploy-related jobs keyed by jobId (build-check + deploy). */
  jobsById: Record<string, AgentJob>;
  /** QA report — drives the Ready/Not-ready verdict. */
  qaReport: QaReport | null;
  nowIso?: string;
}

// ── Step parsing from AgentJob ──────────────────────────────────────
//
// The existing deploy pipeline is a single AgentJob with one shell step that
// runs `build + sync + invalidate`. We heuristically project it into four
// display-level steps so the UI can show progress even though backend-side
// we don't record sub-steps. Over time the daemon could emit 4 separate
// step_complete events for a real breakdown.

function projectSteps(job: AgentJob | undefined): DeployStepStatus[] {
  if (!job) {
    return [
      { id: 'build', label: 'Build', status: 'pending' },
      { id: 'sync', label: 'Sync to S3', status: 'pending' },
      { id: 'invalidate', label: 'Invalidate CDN', status: 'pending' },
      { id: 'verify', label: 'Verify URL', status: 'pending' },
    ] satisfies DeployStepStatus[];
  }

  // Job-level status projects onto every step:
  //   PENDING → all pending
  //   RUNNING → early steps running/pending; we conservatively mark the first
  //             as running and the rest pending
  //   COMPLETED → all pass
  //   FAILED → use DEPLOY_DETAILS if it names a step, else mark first as fail
  const vars = job.variables ?? {};
  const detail = vars.DEPLOY_DETAILS;

  if (job.status === 'PENDING' || job.status === 'RUNNING') {
    return [
      { id: 'build', label: 'Build', status: 'running' },
      { id: 'sync', label: 'Sync to S3', status: 'pending' },
      { id: 'invalidate', label: 'Invalidate CDN', status: 'pending' },
      { id: 'verify', label: 'Verify URL', status: 'pending' },
    ] satisfies DeployStepStatus[];
  }

  if (job.status === 'COMPLETED') {
    return [
      { id: 'build', label: 'Build', status: 'pass', detail },
      { id: 'sync', label: 'Sync to S3', status: 'pass' },
      { id: 'invalidate', label: 'Invalidate CDN', status: 'pass' },
      { id: 'verify', label: 'Verify URL', status: 'pass', detail: vars.DEPLOY_URL },
    ] satisfies DeployStepStatus[];
  }

  // FAILED
  return [
    { id: 'build', label: 'Build', status: 'fail', detail: job.errorMessage || detail },
    { id: 'sync', label: 'Sync to S3', status: 'skipped' },
    { id: 'invalidate', label: 'Invalidate CDN', status: 'skipped' },
    { id: 'verify', label: 'Verify URL', status: 'skipped' },
  ] satisfies DeployStepStatus[];
}

function toDeployRecord(job: AgentJob, epicId: string): DeployRecord {
  const durationSec =
    job.updatedAt && job.createdAt
      ? Math.max(0, (Date.parse(job.updatedAt) - Date.parse(job.createdAt)) / 1000)
      : undefined;
  return {
    jobId: job.jobId,
    epicId,
    status: job.status,
    startedAtIso: job.createdAt,
    finishedAtIso:
      job.status === 'COMPLETED' || job.status === 'FAILED' ? job.updatedAt : undefined,
    durationSec,
    publicUrl: job.variables?.DEPLOY_URL,
    sha: job.variables?.COMMIT_SHA,
    steps: projectSteps(job),
    detail: job.variables?.DEPLOY_DETAILS,
    errorMessage: job.errorMessage,
  };
}

// ── Environment ladder (Deployment v2.5) ───────────────────────────
//
// Derive each rung's live status from the recorded URL + the rung's latest
// job. Same status rules as the QA dev-preview, applied per environment.

function envPublishStatus(
  url: string | undefined,
  job: AgentJob | undefined,
): DeployEnvironmentStatus['status'] {
  let status: DeployEnvironmentStatus['status'] = url ? 'live' : 'none';
  if (job) {
    if (job.status === 'PENDING' || job.status === 'RUNNING') status = 'deploying';
    else if (job.status === 'FAILED' || job.status === 'NEEDS_ATTENTION') status = 'failed';
    else if (job.status === 'COMPLETED') status = url ? 'live' : 'none';
  }
  return status;
}

/**
 * Deployment v2.5 — read the smoke-test outcome from a deploy/promote job's
 * SMOKE_STATUS variable (emitted by the promote pipeline). Normalizes casing
 * and synonyms; anything unrecognized or absent is `undefined` (UI shows
 * nothing). Contract: exactly `'pass' | 'fail' | undefined`.
 */
function deriveSmokeStatus(job: AgentJob | undefined): DeployEnvironmentStatus['smokeStatus'] {
  const v = job?.variables?.SMOKE_STATUS?.toLowerCase();
  if (v === 'pass' || v === 'green' || v === 'ok' || v === '200') return 'pass';
  if (v === 'fail' || v === 'red') return 'fail';
  return undefined;
}

function buildEnvironments(
  plan: Plan,
  jobsById: Record<string, AgentJob>,
  latestProdJobId: string | undefined,
): DeployEnvironmentStatus[] {
  const devJob = plan.devDeployJobId ? jobsById[plan.devDeployJobId] : undefined;
  const stagingJob = plan.stagingDeployJobId ? jobsById[plan.stagingDeployJobId] : undefined;
  const prodJob = latestProdJobId ? jobsById[latestProdJobId] : undefined;
  return [
    {
      environment: 'dev',
      url: plan.devUrl,
      status: envPublishStatus(plan.devUrl, devJob),
      canPromote: false, // dev is reached by deploy, not promote
      activeJobId: devJob?.jobId,
      smokeStatus: deriveSmokeStatus(devJob),
    },
    {
      environment: 'staging',
      url: plan.stagingUrl,
      status: envPublishStatus(plan.stagingUrl, stagingJob),
      canPromote: !!plan.devUrl, // promote dev → staging once dev is live
      activeJobId: stagingJob?.jobId,
      smokeStatus: deriveSmokeStatus(stagingJob),
    },
    {
      environment: 'production',
      url: plan.deployUrl,
      status: envPublishStatus(plan.deployUrl, prodJob),
      canPromote: !!plan.stagingUrl, // promote staging → production once staging is live
      activeJobId: prodJob?.jobId,
      smokeStatus: deriveSmokeStatus(prodJob),
    },
  ];
}

// ── Top-level aggregator ────────────────────────────────────────────

export function buildDeployReport(inputs: DeployAggregatorInputs): DeployReport {
  const { plan, epics, jobsById, qaReport } = inputs;

  // Resolve deploy history. Prefer plan.deployJobIds; fall back to the final
  // epic's deployJobId for legacy plans.
  let jobIds: string[] = plan.deployJobIds ?? [];
  if (jobIds.length === 0) {
    const sorted = [...epics].sort((a, b) => (b.epicWave ?? 0) - (a.epicWave ?? 0));
    const finalEpic = sorted[0];
    if (finalEpic?.deployJobId) jobIds = [finalEpic.deployJobId];
  }

  const finalEpic = [...epics].sort((a, b) => (b.epicWave ?? 0) - (a.epicWave ?? 0))[0];
  const finalEpicId = finalEpic?.epicId ?? plan.planId;

  const records: DeployRecord[] = [];
  for (const jobId of jobIds) {
    const job = jobsById[jobId];
    if (!job) continue;
    records.push(toDeployRecord(job, finalEpicId));
  }

  // Sort descending by startedAt so records[0] is the most recent.
  records.sort((a, b) => b.startedAtIso.localeCompare(a.startedAtIso));
  const current = records[0] ?? null;
  const history = records.slice(1);

  // Verdict decision cascade.
  const qaReady = qaReport?.verdict === 'ready' || qaReport?.verdict === 'not-run';
  const qaBlocking = qaReport?.verdict === 'blocking' || qaReport?.verdict === 'needs-attention';

  let verdict: DeployVerdict;
  let statusReason: string | undefined;
  if (!current) {
    if (qaBlocking) {
      verdict = 'not-ready';
      statusReason = qaReport?.blockingReason || 'QA is not green yet.';
    } else {
      verdict = 'never-deployed';
    }
  } else if (current.status === 'PENDING' || current.status === 'RUNNING') {
    verdict = 'deploying';
  } else if (current.status === 'FAILED') {
    verdict = 'failed';
    statusReason = current.errorMessage || 'Most recent deploy failed.';
  } else {
    // COMPLETED. If QA is now blocking, warn but keep `live`.
    verdict = 'live';
    if (qaBlocking) {
      statusReason = 'Live — but QA has regressed since. Review before re-deploying.';
    }
  }
  // Suppress unused warning: qaReady is derived for readability; `qaBlocking`
  // is what actually drives verdict. Keep both for future tightening.
  void qaReady;

  // 2026-06-01 — the deploy publishes to `apps/<appId>/`, where appId is the
  // working-dir leaf (`/home/ubuntu/projects/<appId>` → `dino1`), NOT the plan
  // name (`dino1-initial`). The report previously used `plan.name`, producing a
  // dead "Open live" link to an empty S3 prefix that fell through to the
  // futurator.ai homepage. Derive the slug the same way the Deploy Agent does
  // (functions/api/index.ts: `epic.workingDir.split('/').pop()`) so they match.
  const appSlug = plan.workingDir.split('/').filter(Boolean).pop() || plan.name;
  // Deployment v2.5 — derive from the shared resolver so the CloudFront id is
  // always populated (fixes the previously-blank Environment footer) and the
  // production target stays in lockstep with what the deploy agent publishes.
  const prodResolved = resolveDeployTarget(appSlug, 'production');
  const target: DeployTarget = {
    publicUrl: prodResolved.publicUrl,
    s3Bucket: prodResolved.s3Bucket,
    s3Prefix: prodResolved.s3Prefix,
    cloudfrontDistributionId: prodResolved.cloudfrontDistributionId,
  };

  const handoff: DeployHandoff = {
    planName: plan.name,
    displayName: plan.displayName,
    rigor: plan.rigor ?? 'mvp',
    stories: { done: plan.doneStories, total: plan.totalStories },
    costUsd: plan.totalCostUsd,
    qaVerdict: qaReport?.verdict ?? 'not-run',
    thumbnailUrls: (qaReport?.vqa.thumbnails ?? [])
      .filter((t) => t.passed && t.screenshotUrl)
      .slice(0, 3)
      .map((t) => t.screenshotUrl as string),
  };

  return {
    planId: plan.planId,
    verdict,
    statusReason,
    target,
    handoff,
    environments: buildEnvironments(plan, jobsById, current?.jobId),
    current,
    history,
    generatedAt: inputs.nowIso ?? new Date().toISOString(),
  };
}
