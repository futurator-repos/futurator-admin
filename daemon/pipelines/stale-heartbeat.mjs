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
 * Cross-daemon reap-ownership guard (pacman1 triple-mint, 2026-07-13).
 *
 * TWO daemons share the agent-jobs table (EC2 production + an optional laptop
 * for 'local'-targeted queue calls). The `!activeJobs.has(jobId)` guard at the
 * reap call site is PROCESS-LOCAL — a laptop daemon's map is empty for every
 * EC2 job, so it saw EC2's live story-dev jobs (whose lastHeartbeatAt was
 * written once at start; the claude spawn runs >5 min with no DDB write),
 * declared them crashed, marked them STALE, and orphan-released their story
 * claims — the frontier then re-minted a duplicate job every ~5 minutes while
 * the "dead" implementers kept running (three concurrent claudes racing one
 * story's files).
 *
 * The rule: a daemon may reap ONLY jobs its own source claimed
 * (`job.claimedBySource`, stamped by runJobAsync at start). Rows from before
 * the stamp existed have no owner — only the production 'ec2' daemon may reap
 * those, so a guest laptop can never touch them. PURE.
 */
export function canReapJob(job, { source = 'local' } = {}) {
  const owner = job?.claimedBySource;
  if (owner) return owner === source;
  return source === 'ec2';
}

/**
 * 2026-06-16 — job types whose orphaned-RUNNING rows are SAFE to AUTO-REQUEUE
 * (reset to PENDING) when a daemon restart kills them mid-run, rather than just
 * marked STALE (terminal). These are IDEMPOTENT infra jobs:
 *   • app-bootstrap — bare-clone is idempotent, commit-and-push no-ops on
 *     re-run, and `bootstrappedAt` is written only on success. A genuinely
 *     failing run lands FAILED via its own catch (not RUNNING), so requeue
 *     never loops.
 * Story/dev/orchestrator jobs are deliberately NOT here — their state is too
 * fragile to rebuild from outside, so they stay on the mark-STALE path.
 *
 * Root cause this fixes: a deploy restarting the daemon mid-`app-bootstrap`
 * left the job stuck RUNNING; the old path only marked it STALE, so the App
 * sat on "Scaffold pending" forever (brick1, 2026-06-16).
 */
export const REQUEUE_ON_ORPHAN_JOB_TYPES = ['app-bootstrap'];

/**
 * True iff a job is a stale, orphaned RUNNING instance that is SAFE to
 * auto-requeue. Two classes qualify:
 *   • idempotent infra job types in `requeueJobTypes` (e.g. app-bootstrap), and
 *   • autopilot concept-gen jobs (Story 3.4) — generic pipeline jobs the Concept
 *     driver stamps with `conceptAutopilotGen: true`. A one-shot generator
 *     (prd/ux/arch) is safe to re-run: the daemon write-back is idempotent and
 *     the apply-service no-ops identical content. INTERACTIVE convergence turns
 *     are NEVER stamped this way (mid-conversation state) — they stay mark-STALE.
 *
 * Pure — the daemon adds the `!activeJobs.has(jobId)` guard (its own in-flight
 * jobs) at the call site.
 */
export function isRequeueableOrphan(
  job,
  { now = Date.now(), staleMs = DEFAULT_STALE_MS, requeueJobTypes = REQUEUE_ON_ORPHAN_JOB_TYPES } = {},
) {
  if (!isStaleAnyPhase(job, { now, staleMs })) return false;
  if (requeueJobTypes.includes(job?.jobType)) return true;
  return job?.conceptAutopilotGen === true;
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
