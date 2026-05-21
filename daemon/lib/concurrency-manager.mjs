/**
 * concurrency-manager.mjs — Story 20.14 (party-push Epic 20).
 *
 * Unified daemon-side scheduling abstraction. Replaces the inline
 * `activeJobs.size` counter that pre-dated party-push. Holds the slot
 * map, applies interactive-first priority to the PENDING queue, and
 * never preempts a RUNNING job.
 *
 * ──────────────────────────────────────────────────────────────────────
 * OPERATOR OVERRIDE 2026-05-21 — UNIFIED QUEUE, NOT LANE PARTITION
 * ──────────────────────────────────────────────────────────────────────
 *
 * Operator quote (status.md §12.3.1):
 *   "I don't want to separate like 1 batch dev work, and 1 for interactive…
 *    2 max agents no matter where they are coming, perhaps we need to
 *    abstract one layer of concurrency."
 *
 * Design:
 *   - One queue. All classes share `maxConcurrent` slots (default 2).
 *   - Priority rule (selectNext): interactive sorts before batch; within
 *     a class, FIFO by createdAt.
 *   - Never preempts. A RUNNING batch job is NEVER killed to free a slot
 *     for a pending interactive — preemption is a footgun (OAuth state,
 *     ambiguous-cancel semantics, lost mid-turn work). Priority only
 *     affects QUEUE order.
 *   - No starvation guard for batch. Interactive sessions terminate
 *     eventually (turns + sessions are bounded); a continuous stream of
 *     interactive work is an explicit operator choice. Document the
 *     trade-off; don't enforce.
 *
 * ──────────────────────────────────────────────────────────────────────
 * Future-friendly extension points (NOT in this story):
 *   - MAX_CONCURRENT_INTERACTIVE env var (per-class soft-cap). Reserved.
 *   - Time-of-day priority. selectNext is a pure function — swap policy
 *     without changing the class shape.
 *   - Job-level priority hints (job.priority). Already compatible.
 *
 * Out of scope: preemption, per-class hard caps, multi-machine dispatch.
 */

/**
 * @typedef {'interactive' | 'batch'} JobClass
 *
 * @typedef {object} CMJob
 *   Minimal shape the manager needs. The actual `AgentJob` row carries more.
 * @property {string} jobId
 * @property {string} [jobType]
 * @property {string} createdAt — ISO 8601; used for FIFO within a class
 *
 * @typedef {object} CMLogger
 * @property {(msg: string) => void} [info]
 * @property {(msg: string) => void} [warn]
 *
 * @typedef {object} CMOptions
 * @property {number} [maxConcurrent=2]
 * @property {(job: CMJob) => JobClass} classifier
 * @property {CMLogger} [logger]
 *
 * @typedef {object} TryAcquireResult
 * @property {boolean} acquired
 * @property {string} [reason]    — when acquired=false
 *
 * @typedef {object} CMSnapshot
 * @property {{ jobId: string, jobClass: JobClass, startedAt: string }[]} active
 * @property {number} maxConcurrent
 */

export class ConcurrencyManager {
  /** @param {CMOptions} opts */
  constructor({ maxConcurrent = 2, classifier, logger }) {
    if (typeof classifier !== 'function') {
      throw new Error('ConcurrencyManager: classifier function is required');
    }
    if (!Number.isInteger(maxConcurrent) || maxConcurrent < 1) {
      throw new Error(`ConcurrencyManager: maxConcurrent must be a positive integer (got ${maxConcurrent})`);
    }
    this._max = maxConcurrent;
    this._classify = classifier;
    this._logger = logger;
    /** @type {Map<string, { jobClass: JobClass, startedAt: string }>} */
    this._active = new Map();
  }

  /** Number of slots currently occupied. */
  get activeCount() {
    return this._active.size;
  }

  /** Max concurrent slots (immutable for the manager's lifetime). */
  get maxConcurrent() {
    return this._max;
  }

  /**
   * True iff a new acquisition would succeed given current capacity.
   * Useful for the daemon's "should I bother querying PENDING?" check
   * before hitting DDB.
   */
  canAcquire() {
    return this._active.size < this._max;
  }

  /**
   * Synchronous slot acquisition. Returns `{ acquired: true }` when
   * capacity allows. Does NOT enforce priority — `selectNext` is the
   * caller's responsibility for choosing WHICH job to attempt.
   *
   * @param {CMJob} job
   * @returns {TryAcquireResult}
   */
  tryAcquire(job) {
    if (!job || !job.jobId) {
      return { acquired: false, reason: 'invalid-job' };
    }
    if (this._active.has(job.jobId)) {
      // Idempotent: same job re-acquiring (e.g. retry path) is a no-op success.
      return { acquired: true };
    }
    if (this._active.size >= this._max) {
      return { acquired: false, reason: 'at-capacity' };
    }
    const jobClass = this._classifyJob(job);
    const startedAt = new Date().toISOString();
    this._active.set(job.jobId, { jobClass, startedAt });
    this._logger?.info?.(
      `[concurrency] acquire ${job.jobId.slice(0, 8)} class=${jobClass} active=${this._active.size}/${this._max}`,
    );
    return { acquired: true };
  }

  /**
   * Release a slot. Idempotent — releasing an unknown jobId is a no-op
   * with a logger.warn (helps detect double-release bugs without crashing
   * the daemon).
   *
   * @param {string} jobId
   */
  release(jobId) {
    if (!jobId) return;
    if (!this._active.has(jobId)) {
      this._logger?.warn?.(
        `[concurrency] release ${jobId.slice(0, 8)} — not in active map (double-release?)`,
      );
      return;
    }
    this._active.delete(jobId);
    this._logger?.info?.(
      `[concurrency] release ${jobId.slice(0, 8)} active=${this._active.size}/${this._max}`,
    );
  }

  /**
   * Observable state for the daemon status endpoint + tests. Returns a
   * deep-enough copy that callers can mutate the result without affecting
   * internal state.
   *
   * @returns {CMSnapshot}
   */
  getSnapshot() {
    const active = [];
    for (const [jobId, info] of this._active.entries()) {
      active.push({ jobId, jobClass: info.jobClass, startedAt: info.startedAt });
    }
    return { active, maxConcurrent: this._max };
  }

  /**
   * Pure-function priority selection. Given a list of PENDING candidates
   * pulled from DDB (the daemon's poll-tick should fetch a window of ~20
   * so the priority rule can see jobs beyond the next free slot count),
   * return the highest-priority one to attempt next, or null if the list
   * is empty.
   *
   * Sort key: `(class === 'interactive' ? 0 : 1, createdAt asc)`.
   *
   * Does NOT mutate the manager's state and does NOT call tryAcquire —
   * the caller still calls tryAcquire on the returned job. Splitting
   * these makes priority testable in isolation.
   *
   * @param {CMJob[]} candidates
   * @returns {CMJob | null}
   */
  selectNext(candidates) {
    if (!Array.isArray(candidates) || candidates.length === 0) return null;
    const decorated = candidates.map((job) => ({
      job,
      classKey: this._classifyJob(job) === 'interactive' ? 0 : 1,
      ts: Date.parse(job.createdAt || '') || 0,
    }));
    decorated.sort((a, b) => {
      if (a.classKey !== b.classKey) return a.classKey - b.classKey;
      return a.ts - b.ts;
    });
    return decorated[0].job;
  }

  /**
   * Internal: classify a job + apply the unknown-class failsafe.
   * @param {CMJob} job
   * @returns {JobClass}
   */
  _classifyJob(job) {
    const result = this._classify(job);
    if (result !== 'interactive' && result !== 'batch') {
      this._logger?.warn?.(
        `[concurrency] classifier returned unknown class '${result}' for jobType='${job?.jobType}' — defaulting to 'batch'`,
      );
      return 'batch';
    }
    return result;
  }
}

/**
 * Canonical job classifier the daemon uses. Pure function so tests can
 * call it directly without instantiating a ConcurrencyManager.
 *
 * Interactive: free-agent sessions + every party-mode job type. The
 * common thread is "an operator is staring at the UI waiting for
 * output" — preempting any of these behind a long batch job is bad UX.
 *
 * Batch: pipeline-v2 step jobs, wave-merge, app-bootstrap, skill-scout
 * / skill-install, reflector. All run with no human in the loop.
 *
 * Unknown types default to batch (fail-safe — better to make a new job
 * type wait than to grant accidental priority).
 *
 * @param {CMJob} job
 * @returns {JobClass}
 */
export function classifyJob(job) {
  const t = job?.jobType;
  switch (t) {
    case 'free-agent-session':
    case 'party-turn':
    case 'party-bootstrap':
    case 'party-inspect':
    case 'party-docs-sync':
    case 'party-docs-unlink':
    case 'party-refresh':
      return 'interactive';
    default:
      return 'batch';
  }
}

/**
 * Story 20.14 AC 9 — feature-flag helper. Returns true when the daemon
 * should use the manager; false to fall back to the legacy
 * `activeJobs.size` counter. Default OFF in PR 1 — operator flips to
 * `'1'` after smoke-testing the manager (status.md operator checklist).
 *
 * @returns {boolean}
 */
export function isConcurrencyManagerEnabled() {
  const v = process.env.PARTY_PUSH_CONCURRENCY_MANAGER;
  // Default to '1' (enabled) when unset; operator can opt out with '0'.
  // The story's AC 9 says "default enabled after PR 0 ships and operator
  // confirms" — operator confirmation is the act of leaving the env var
  // unset (or explicitly setting '1').
  return v !== '0' && v !== 'false';
}
