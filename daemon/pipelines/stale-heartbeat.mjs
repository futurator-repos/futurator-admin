/**
 * Stale-heartbeat detection for crash-resume (EO-4.5).
 *
 * The daemon writes `lastHeartbeatAt` to a `phase: 'epic-dev'` job when
 * it first spawns the orchestrator, and the orchestrator subagents POST
 * wave-complete events back through the HTTP receiver which also
 * refreshes the timestamp. If the heartbeat goes cold for longer than
 * STALE_MS, the EC2 host most likely crashed mid-epic; this module
 * decides which jobs are stale and shapes the resume PENDING job that
 * replaces them.
 *
 * Pure functions only — no DynamoDB access, no side effects. The daemon
 * wires them into its poll loop.
 */

export const DEFAULT_STALE_MS = 5 * 60 * 1000;

/**
 * Returns true when the job is a RUNNING epic-dev job whose heartbeat
 * is older than `staleMs`. Jobs that have never heartbeated since
 * transitioning to RUNNING are considered stale against `updatedAt`.
 *
 * Kept for backwards-compat with the orchestrator-resume path
 * (`buildResumeJob` only knows how to resume epic-dev jobs).
 */
export function isStale(job, { now = Date.now(), staleMs = DEFAULT_STALE_MS } = {}) {
  if (!job || job.status !== 'RUNNING' || job.phase !== 'epic-dev') return false;
  const ref = job.lastHeartbeatAt || job.updatedAt;
  if (!ref) return false;
  const refMs = Date.parse(ref);
  if (Number.isNaN(refMs)) return false;
  return now - refMs > staleMs;
}

/**
 * PR-28 — broader staleness predicate that catches per-story dev pipeline
 * jobs, not just epic-dev orchestrator jobs.
 *
 * Rationale: when the daemon is killed mid-execution (OOM on t4g.small,
 * SIGKILL, etc.), per-story RUNNING jobs sit in DDB forever because the
 * orchestrator-only `isStale` filters them out. Result: wave-reducer
 * never sees them as terminal → wave never advances → operator must
 * manually clean up. Plan-2 of dino-runner-1 (2026-05-04) hung 3 wave-1
 * stories this way.
 *
 * This predicate is more permissive: any RUNNING job (regardless of
 * phase) whose heartbeat or updatedAt timestamp is older than `staleMs`
 * counts as stale. Callers route the result differently:
 *   • epic-dev jobs → buildResumeJob (continues the orchestrator)
 *   • everything else → mark STALE + emit attention item, no auto-resume
 *     (story state is too fragile to safely rebuild from outside)
 */
export function isStaleAnyPhase(job, { now = Date.now(), staleMs = DEFAULT_STALE_MS } = {}) {
  if (!job || job.status !== 'RUNNING') return false;
  const ref = job.lastHeartbeatAt || job.updatedAt;
  if (!ref) return false;
  const refMs = Date.parse(ref);
  if (Number.isNaN(refMs)) return false;
  return now - refMs > staleMs;
}

/**
 * Select the subset of jobs that should be marked STALE + resumed.
 */
export function findStaleJobs(jobs, opts) {
  if (!Array.isArray(jobs)) return [];
  return jobs.filter((j) => isStale(j, opts));
}

/**
 * Build the replacement PENDING job that resumes from the stale job's
 * accumulated `waveResults`. The new job inherits the epic-dev payload
 * and every correlation field (epicId, projectId, workingDir) from the
 * stale job; only `status`, `jobId`, timestamps, and resume hints change.
 *
 * The caller supplies `newJobId` (typically a fresh UUID) and `now` so
 * this function stays deterministic and testable.
 */
export function buildResumeJob(staleJob, { newJobId, now }) {
  if (!staleJob) throw new Error('buildResumeJob: staleJob is required');
  if (!newJobId) throw new Error('buildResumeJob: newJobId is required');
  if (!now) throw new Error('buildResumeJob: now is required');

  const resumeFromWaveResults = staleJob.waveResults && Object.keys(staleJob.waveResults).length > 0
    ? staleJob.waveResults
    : undefined;

  return {
    jobId: newJobId,
    status: 'PENDING',
    phase: 'epic-dev',
    epicId: staleJob.epicId,
    projectId: staleJob.projectId,
    workingDir: staleJob.workingDir,
    epicDevPayload: staleJob.epicDevPayload,
    resumeFromWaveResults,
    resumedFromJobId: staleJob.jobId,
    pipeline: staleJob.pipeline || { agents: {}, steps: [] },
    createdAt: now,
    updatedAt: now,
    createdBy: staleJob.createdBy || 'daemon:resume',
  };
}
