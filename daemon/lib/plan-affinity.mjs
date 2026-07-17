// plan-affinity — stamp plan-affinity (+ optional self-assign) onto a
// plan-scoped agent job the daemon creates. Servers module (spec §5).
//
// The dispatch engine (functions/shared/services/dispatch-policy.ts) reads
// job.affinityKey — format `plan:<planId>` — and pins every job of a plan to
// one server via the persisted affinity-owner map. Nothing wrote affinityKey
// until this module; the sweeper (server-dispatcher.ts) then stamps
// assignedServerId on each job up to ~60s later.
//
// SELF-ASSIGN OPTIMIZATION: when a daemon creates a plan-scoped job AND the
// creating context's parent job was itself assigned to THIS server, we can skip
// the sweeper round-trip and stamp assignedServerId=<self> right now — affinity
// would force the same server anyway (the plan's worktree/branch lives there).
// Guarded hard: when server-aware dispatch is OFF, or the parent has no
// assignedServerId (legacy job / no parent context), we stamp ONLY affinityKey
// so legacy behavior is byte-for-byte unchanged.

/**
 * Build the affinity (and optional self-assign) fields to spread onto a
 * plan-scoped job at creation.
 *
 * @param {{
 *   planId?: string,
 *   parentJob?: { jobId?: string, assignedServerId?: string } | null,
 *   serverId?: string,
 *   serverAware?: boolean,
 *   nowIso?: string,
 * }} args
 * @returns {{ affinityKey?: string, assignedServerId?: string, assignedAt?: string, assignReason?: string }}
 *   Fields to spread onto the job Item. Empty object when `planId` is absent.
 */
export function planAffinityStamp({
  planId,
  parentJob = null,
  serverId,
  serverAware = false,
  nowIso,
} = {}) {
  if (!planId) return {};
  const stamp = { affinityKey: `plan:${planId}` };
  if (serverAware && serverId && parentJob && parentJob.assignedServerId === serverId) {
    stamp.assignedServerId = serverId;
    stamp.assignedAt = nowIso || new Date().toISOString();
    stamp.assignReason = `inherited: plan affinity (parent ${parentJob.jobId || 'unknown'})`;
  }
  return stamp;
}
