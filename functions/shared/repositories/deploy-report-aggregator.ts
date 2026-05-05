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
  DeployHandoff,
  DeployRecord,
  DeployReport,
  DeployStepStatus,
  DeployTarget,
  DeployVerdict,
} from '../types/deploy-report';
import type { QaReport } from '../types/qa-report';

/** FUTURATOR_PUBLIC_BUCKET — must match the env var in sst.config.ts. */
const PUBLIC_BUCKET = 'futurator-ai-website';

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
    return ([
      { id: 'build', label: 'Build', status: 'pending' },
      { id: 'sync', label: 'Sync to S3', status: 'pending' },
      { id: 'invalidate', label: 'Invalidate CDN', status: 'pending' },
      { id: 'verify', label: 'Verify URL', status: 'pending' },
    ] satisfies DeployStepStatus[]);
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
    return ([
      { id: 'build', label: 'Build', status: 'running' },
      { id: 'sync', label: 'Sync to S3', status: 'pending' },
      { id: 'invalidate', label: 'Invalidate CDN', status: 'pending' },
      { id: 'verify', label: 'Verify URL', status: 'pending' },
    ] satisfies DeployStepStatus[]);
  }

  if (job.status === 'COMPLETED') {
    return ([
      { id: 'build', label: 'Build', status: 'pass', detail },
      { id: 'sync', label: 'Sync to S3', status: 'pass' },
      { id: 'invalidate', label: 'Invalidate CDN', status: 'pass' },
      { id: 'verify', label: 'Verify URL', status: 'pass', detail: vars.DEPLOY_URL },
    ] satisfies DeployStepStatus[]);
  }

  // FAILED
  return ([
    { id: 'build', label: 'Build', status: 'fail', detail: job.errorMessage || detail },
    { id: 'sync', label: 'Sync to S3', status: 'skipped' },
    { id: 'invalidate', label: 'Invalidate CDN', status: 'skipped' },
    { id: 'verify', label: 'Verify URL', status: 'skipped' },
  ] satisfies DeployStepStatus[]);
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
  const qaBlocking =
    qaReport?.verdict === 'blocking' || qaReport?.verdict === 'needs-attention';

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

  const target: DeployTarget = {
    publicUrl: `https://futurator.ai/apps/${plan.name}/`,
    s3Bucket: PUBLIC_BUCKET,
    s3Prefix: `apps/${plan.name}/`,
    cloudfrontDistributionId: process.env.CLOUDFRONT_DISTRIBUTION_ID || undefined,
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
    current,
    history,
    generatedAt: inputs.nowIso ?? new Date().toISOString(),
  };
}
