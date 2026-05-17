/**
 * Steps orchestrator for migrate-brownfield.mjs.
 *
 * Each step is a small async function that returns
 *   { outcome: 'done'|'skip'|'manual'|'fail', message?, hint?, data? }
 *
 * - 'done'   newly executed this run
 * - 'skip'   already-in-the-desired-state (idempotent re-run)
 * - 'manual' operator action required (e.g. attach IAM policy); orchestrator
 *            prints the hint and exits non-zero so the next invocation can
 *            re-check
 * - 'fail'   unrecoverable; orchestrator surfaces the message and exits
 *
 * Steps live here so the entry-point `migrate-brownfield.mjs` stays a
 * thin orchestrator that just sequences these calls and renders output.
 *
 * Steps 1–2 (resolve URL/SHA) live in preflights.mjs because they're
 * pure local filesystem + git reads. Steps 3+ go through the network /
 * AWS / admin API.
 */

import { execFileSync } from 'node:child_process';
import { AdminApiError } from './admin-client.mjs';
import { ensureSecret } from './aws-helpers.mjs';

/** Resolve HEAD SHA via `git rev-parse HEAD`. Used to verify
 *  post-migration that EC2 mirrored what we expected. */
export function resolveHeadSha(repoPath, runner = defaultGitRunner) {
  try {
    return runner(repoPath, ['rev-parse', 'HEAD']);
  } catch {
    return null;
  }
}

function defaultGitRunner(cwd, args) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

// ──────────────────────────────────────────────────────────────────────
// Step 3 — ensure AWS Secrets Manager secret
// ──────────────────────────────────────────────────────────────────────

export async function stepEnsureSecret({ secretName, pat, rotate, secretsClient }) {
  try {
    const r = await ensureSecret({ secretName, pat, rotate, client: secretsClient });
    if (r.outcome === 'created') {
      return { outcome: 'done', message: `created secret ${secretName}`, data: r };
    }
    if (r.outcome === 'rotated') {
      return { outcome: 'done', message: `rotated secret ${secretName}`, data: r };
    }
    return { outcome: 'skip', message: `secret ${secretName} already exists`, data: r };
  } catch (err) {
    return {
      outcome: 'fail',
      message: `failed to ensure secret ${secretName}: ${err.message || err}`,
    };
  }
}

// ──────────────────────────────────────────────────────────────────────
// Step 4 — IAM policy hint (manual)
//
// We don't try to attach the policy ourselves. The operator runs the
// printed command once; on subsequent runs they pass --skip-iam-check
// to short-circuit this step.
// ──────────────────────────────────────────────────────────────────────

export function stepIamPolicyHint({ skipIamCheck, hint }) {
  if (skipIamCheck) {
    return {
      outcome: 'skip',
      message: 'IAM check skipped (--skip-iam-check); assuming policy is attached',
    };
  }
  return {
    outcome: 'manual',
    message:
      'attach the inline IAM policy to the daemon EC2 role (one-time). After running the command below, re-invoke this script with --skip-iam-check.',
    hint,
  };
}

// ──────────────────────────────────────────────────────────────────────
// Step 5 — SST deploy / daemon restart reminder
//
// We don't auto-deploy. We just remind the operator on first run that
// `sst deploy` + daemon restart must have happened with the Story 15.4
// code present. If the daemon log didn't show `[brownfield-pat] loaded`,
// registration will fail.
// ──────────────────────────────────────────────────────────────────────

export function stepDeployReminder({ adminHealthOk }) {
  if (!adminHealthOk) {
    return {
      outcome: 'fail',
      message:
        'admin API not reachable — make sure you ran `sst deploy` and the API Lambda is up before continuing',
    };
  }
  return {
    outcome: 'skip',
    message:
      'admin API healthy. (Confirm separately that the daemon has been restarted with the new code — look for `[brownfield-pat] loaded` in daemon logs.)',
  };
}

// ──────────────────────────────────────────────────────────────────────
// Step 6 — register project (or skip if already exists)
// ──────────────────────────────────────────────────────────────────────

export async function stepRegisterOrFetch({ adminClient, name, gitRepoUrl, gitBranch }) {
  // Check if it already exists.
  let existing = null;
  try {
    existing = await adminClient.getProject(name);
  } catch (err) {
    if (!(err instanceof AdminApiError) || err.status !== 404) {
      return { outcome: 'fail', message: `unexpected error reading project: ${err.message}` };
    }
  }

  if (existing) {
    if (existing.kind !== 'brownfield') {
      return {
        outcome: 'fail',
        message: `project "${name}" already exists but is greenfield; refusing to convert. Use a different --name or delete the existing project.`,
      };
    }
    return {
      outcome: 'skip',
      message: `project "${name}" already registered as brownfield (status: ${existing.bmadStatus})`,
      data: { project: existing, jobId: null },
    };
  }

  // Fresh registration.
  try {
    const res = await adminClient.registerBrownfield({ name, gitRepoUrl, gitBranch });
    return {
      outcome: 'done',
      message: `registered project "${name}"; bootstrap job ${res.jobId}`,
      data: { jobId: res.jobId, projectId: res.projectId },
    };
  } catch (err) {
    return {
      outcome: 'fail',
      message: `register failed: ${err.message}`,
      data: err instanceof AdminApiError ? { status: err.status, body: err.body } : undefined,
    };
  }
}

// ──────────────────────────────────────────────────────────────────────
// Step 7 — poll bootstrap events (or refresh events) until terminal
// ──────────────────────────────────────────────────────────────────────

export async function stepPollEvents({
  adminClient,
  jobId,
  onEvent,
  intervalMs = 1500,
  timeoutMs = 5 * 60 * 1000,
}) {
  if (!jobId) {
    return {
      outcome: 'skip',
      message: 'no jobId to poll (project was already provisioned)',
    };
  }
  const r = await adminClient.pollJobEvents(jobId, { intervalMs, timeoutMs, onEvent });
  if (r.outcome === 'completed') {
    return { outcome: 'done', message: `job ${jobId} completed`, data: r };
  }
  if (r.outcome === 'failed') {
    const reason = r.terminal?.payload?.failureReason || r.terminal?.payload?.reason || 'unknown';
    return {
      outcome: 'fail',
      message: `job ${jobId} failed: ${reason}`,
      data: r,
    };
  }
  return {
    outcome: 'fail',
    message: `job ${jobId} timed out — check daemon logs and \`/api/agent-jobs/${jobId}/events\` manually`,
    data: r,
  };
}

// ──────────────────────────────────────────────────────────────────────
// Step 8 — verify final state
// ──────────────────────────────────────────────────────────────────────

export async function stepVerifyHealthy({ adminClient, name, expectedHeadSha }) {
  let project;
  try {
    project = await adminClient.getProject(name);
  } catch (err) {
    return { outcome: 'fail', message: `verify: getProject failed: ${err.message}` };
  }
  if (!project || project.bmadStatus !== 'HEALTHY') {
    return {
      outcome: 'fail',
      message: `verify: expected bmadStatus=HEALTHY, got ${project?.bmadStatus}${
        project?.failureReason ? ` (reason: ${project.failureReason})` : ''
      }`,
      data: project,
    };
  }
  if (project.kind !== 'brownfield') {
    return {
      outcome: 'fail',
      message: `verify: expected kind=brownfield, got ${project.kind}`,
      data: project,
    };
  }
  if (expectedHeadSha && project.lastCommitSha && expectedHeadSha !== project.lastCommitSha) {
    return {
      outcome: 'done',
      message: `verify: HEALTHY but lastCommitSha (${project.lastCommitSha}) differs from local HEAD (${expectedHeadSha}) — did you forget to push?`,
      data: project,
    };
  }
  return {
    outcome: 'done',
    message: `verify: ${name} is HEALTHY at ${project.lastCommitSha || '(no commit sha)'} on ${
      project.gitBranch
    }`,
    data: project,
  };
}

// ──────────────────────────────────────────────────────────────────────
// Refresh path (alternative to register+poll)
// ──────────────────────────────────────────────────────────────────────

export async function stepRefreshExisting({ adminClient, name }) {
  let existing;
  try {
    existing = await adminClient.getProject(name);
  } catch (err) {
    if (err instanceof AdminApiError && err.status === 404) {
      return {
        outcome: 'fail',
        message: `--refresh requested but project "${name}" is not registered yet. Drop --refresh to register it.`,
      };
    }
    return { outcome: 'fail', message: `unexpected error reading project: ${err.message}` };
  }
  if (existing.kind !== 'brownfield') {
    return {
      outcome: 'fail',
      message: `project "${name}" is greenfield; refresh is only for brownfield projects`,
    };
  }
  try {
    const res = await adminClient.refreshProject(name);
    return {
      outcome: 'done',
      message: `refresh enqueued; job ${res.jobId}`,
      data: { jobId: res.jobId, projectId: res.projectId },
    };
  } catch (err) {
    return { outcome: 'fail', message: `refresh failed: ${err.message}` };
  }
}
