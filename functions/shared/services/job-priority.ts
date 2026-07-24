/**
 * job-priority.ts — the JOB-priority half of the multi-host dispatcher.
 *
 * The dispatcher answers two independent questions when a host frees a slot:
 *   • WHICH HOST takes a job?  → server-selection DispatchPolicy
 *                                 (mode/priorityOrder/weights) + capability
 *                                 eligibility (dispatch-capabilities.ts).
 *   • WHICH JOB goes first?    → THIS FILE. Given the set of eligible PENDING
 *                                 jobs, rank them by operator-configured tiers.
 *
 * This mirrors the SPIRIT of the daemon ConcurrencyManager's `selectNext`
 * (interactive class sorts before batch; createdAt breaks ties) but generalises
 * the binary class into an ORDERED, configurable list of tiers. Kept a pure,
 * dependency-free function so it can be shared by the API, the Servers UI, and
 * (via a small `.mjs` mirror, NEXT WEEK) the daemon's claim loop.
 *
 * App-agnostic: tiers are keyed by `jobType` strings only — no app/plan/content
 * knowledge lives here.
 */
import { DEFAULT_JOB_PRIORITY_TIERS, type JobPriorityTier } from '../types/compute-server';

/** Minimal shape this ranker needs from a job (structural — no import cycle). */
export interface PriorityJob {
  jobType?: string;
  /** ISO timestamp; used only as the within-tier FIFO tiebreak. */
  createdAt?: string;
}

/** Optional carrier for the configured tiers (a DispatchPolicy is assignable). */
export interface JobPriorityConfig {
  jobPriority?: JobPriorityTier[];
}

/** The active tier list: the configured one, or the operator default when the
 *  policy carries none (undefined/empty). */
export function resolveTiers(policy?: JobPriorityConfig | null): JobPriorityTier[] {
  const configured = policy?.jobPriority;
  if (configured && configured.length > 0) return configured;
  return DEFAULT_JOB_PRIORITY_TIERS;
}

/**
 * The rank of a jobType within `tiers`: the index of the first tier that lists
 * it (0 = highest priority). An unrecognised jobType — or a job with no jobType
 * — falls to the LAST tier (the operator's "everything else" band), never
 * ahead of a recognised one. With an empty tier list every job is rank 0, so
 * selection degrades to pure createdAt FIFO.
 */
export function tierIndexOf(jobType: string | undefined, tiers: JobPriorityTier[]): number {
  if (tiers.length === 0) return 0;
  if (jobType) {
    const idx = tiers.findIndex((t) => t.jobTypes.includes(jobType));
    if (idx !== -1) return idx;
  }
  return tiers.length - 1;
}

function createdAtMs(job: PriorityJob): number {
  const t = job.createdAt ? Date.parse(job.createdAt) : NaN;
  // Jobs with a missing/unparseable timestamp sort AFTER dated ones within their
  // tier (treated as "arrived last") rather than jumping the queue as epoch 0.
  return Number.isNaN(t) ? Number.POSITIVE_INFINITY : t;
}

/**
 * Pick the single highest-priority job to run next from a pool of eligible
 * PENDING jobs, or `null` if the pool is empty.
 *
 * Ranking (stable): tier index ASC, then createdAt ASC (FIFO) within a tier,
 * then original input order for exact ties. Pure — does not mutate `pendingJobs`.
 *
 * @param pendingJobs jobs already filtered to those a host may run (capability +
 *                    capacity eligibility is the CALLER's concern, not this fn's).
 * @param policy      carries the configured `jobPriority` tiers; omit/undefined
 *                    uses `DEFAULT_JOB_PRIORITY_TIERS`.
 */
export function selectNext<J extends PriorityJob>(
  pendingJobs: readonly J[],
  policy?: JobPriorityConfig | null,
): J | null {
  if (!pendingJobs || pendingJobs.length === 0) return null;
  const tiers = resolveTiers(policy);

  let best: J | null = null;
  let bestTier = Number.POSITIVE_INFINITY;
  let bestTs = Number.POSITIVE_INFINITY;

  for (const job of pendingJobs) {
    const tier = tierIndexOf(job.jobType, tiers);
    const ts = createdAtMs(job);
    // Strictly-better test keeps the FIRST job on exact ties → stable / FIFO.
    if (tier < bestTier || (tier === bestTier && ts < bestTs)) {
      best = job;
      bestTier = tier;
      bestTs = ts;
    }
  }
  return best;
}
