/**
 * Job router — decides which pipeline entry point runs a given job
 * (EO-4.3). The daemon polls DynamoDB and calls `selectHandler(job)` to
 * decide between the legacy step-based pipeline and the new epic-dev
 * orchestrator pipeline.
 *
 * Legacy jobs have `pipeline.steps` and (usually) no `phase`.
 * New orchestrator jobs MUST set `phase: 'epic-dev'` and carry
 * `epicDevPayload` per `functions/shared/types/agent-orchestrator.ts`.
 */

export const JOB_HANDLER_LEGACY = 'legacy';
export const JOB_HANDLER_EPIC_DEV = 'epic-dev';

/**
 * Decide which handler should run a given job.
 *
 * Returns one of:
 *   - 'epic-dev' when `job.phase === 'epic-dev'`
 *   - 'legacy'   for every other job (including undefined phase)
 *
 * This function is intentionally pure — no I/O, no spawning. Keeping it
 * pure lets us unit-test the dispatch without mocking the Claude CLI or
 * DynamoDB.
 */
export function selectHandler(job) {
  if (!job || typeof job !== 'object') return JOB_HANDLER_LEGACY;
  if (job.phase === 'epic-dev') return JOB_HANDLER_EPIC_DEV;
  return JOB_HANDLER_LEGACY;
}

/**
 * Lightweight structural check for epic-dev jobs. Used by the daemon to
 * reject malformed epic-dev jobs with a clear error BEFORE spawning the
 * orchestrator. Returns { ok: true } or { ok: false, reason }.
 */
export function validateEpicDevJob(job) {
  if (!job || typeof job !== 'object') return { ok: false, reason: 'job-missing' };
  if (job.phase !== 'epic-dev') return { ok: false, reason: 'phase-mismatch' };
  if (!job.jobId) return { ok: false, reason: 'jobId-missing' };
  if (!job.workingDir) return { ok: false, reason: 'workingDir-missing' };
  const p = job.epicDevPayload;
  if (!p || typeof p !== 'object') return { ok: false, reason: 'epicDevPayload-missing' };
  if (!p.orchestratorModel) return { ok: false, reason: 'orchestratorModel-missing' };
  if (!Array.isArray(p.stories) || p.stories.length === 0) {
    return { ok: false, reason: 'stories-empty' };
  }
  return { ok: true };
}
