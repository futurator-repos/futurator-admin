import type { DispatchPolicy } from '../types/compute-server';

export interface EligibleServer {
  serverId: string;
  maxConcurrent: number;
  costPerHour: number;
  activeCount: number; // running now (from heartbeat)
  assignedPending: number; // assigned but not yet claimed
}
export interface PendingJobLite {
  jobId: string;
  createdAt: string;
  affinityKey?: string;
  pinnedServerId?: string;
}
export interface AssignmentDecision {
  jobId: string;
  serverId: string;
  reason: string;
}
export interface PlanResult {
  assignments: AssignmentDecision[];
  unassigned: { jobId: string; reason: string }[];
  affinityOwners: Record<string, string>; // input map + new ownerships
}

export function planAssignments(input: {
  jobs: PendingJobLite[]; // oldest first
  servers: EligibleServer[]; // pre-filtered: ACTIVE + enabled + fresh heartbeat
  policy: DispatchPolicy;
  affinityOwners: Record<string, string>;
}): PlanResult {
  const { jobs, servers, policy } = input;
  const owners = { ...input.affinityOwners };
  const free = new Map<string, number>();
  for (const s of servers) {
    free.set(s.serverId, Math.max(0, s.maxConcurrent - s.activeCount - s.assignedPending));
  }
  const byId = new Map(servers.map((s) => [s.serverId, s]));
  const batchCount = new Map<string, number>(); // weighted-mode deficit tracking
  const assignments: AssignmentDecision[] = [];
  const unassigned: { jobId: string; reason: string }[] = [];

  const take = (serverId: string) => {
    free.set(serverId, (free.get(serverId) ?? 0) - 1);
    batchCount.set(serverId, (batchCount.get(serverId) ?? 0) + 1);
  };

  const policyPick = (): { serverId: string; reason: string } | null => {
    const withCapacity = servers.filter((s) => (free.get(s.serverId) ?? 0) > 0);
    if (withCapacity.length === 0) return null;
    if (policy.mode === 'priority') {
      const order = [
        ...policy.priorityOrder.filter((id) => byId.has(id)),
        ...servers.map((s) => s.serverId).filter((id) => !policy.priorityOrder.includes(id)),
      ];
      const id = order.find((sid) => (free.get(sid) ?? 0) > 0);
      return id
        ? { serverId: id, reason: `priority: ${order.indexOf(id) + 1} of [${order.join(', ')}]` }
        : null;
    }
    if (policy.mode === 'cheapest') {
      const cheapest = [...withCapacity].sort((a, b) => a.costPerHour - b.costPerHour)[0];
      return { serverId: cheapest.serverId, reason: `cheapest: $${cheapest.costPerHour}/h` };
    }
    // weighted: largest deficit = weight share minus share of this batch so far
    const weighted = withCapacity.filter((s) => (policy.weights[s.serverId] ?? 0) > 0);
    if (weighted.length === 0) return null;
    const totalW = weighted.reduce((sum, s) => sum + (policy.weights[s.serverId] ?? 0), 0);
    const totalAssigned = [...batchCount.values()].reduce((a, b) => a + b, 0);
    const pick = [...weighted].sort((a, b) => deficit(b) - deficit(a))[0];
    function deficit(s: EligibleServer): number {
      const target = (policy.weights[s.serverId] ?? 0) / totalW;
      const actual = totalAssigned === 0 ? 0 : (batchCount.get(s.serverId) ?? 0) / totalAssigned;
      return target - actual;
    }
    const pct = Object.entries(policy.weights)
      .map(([k, v]) => `${k} ${v}%`)
      .join(', ');
    return { serverId: pick.serverId, reason: `weighted [${pct}]` };
  };

  for (const j of jobs) {
    if (j.pinnedServerId) {
      if (byId.has(j.pinnedServerId) && (free.get(j.pinnedServerId) ?? 0) > 0) {
        assignments.push({
          jobId: j.jobId,
          serverId: j.pinnedServerId,
          reason: `pinned to ${j.pinnedServerId}`,
        });
        take(j.pinnedServerId);
      } else {
        unassigned.push({
          jobId: j.jobId,
          reason: `pinned server unavailable: ${j.pinnedServerId}`,
        });
      }
      continue;
    }
    if (j.affinityKey && owners[j.affinityKey]) {
      const owner = owners[j.affinityKey];
      if (!byId.has(owner)) {
        unassigned.push({
          jobId: j.jobId,
          reason: `affinity owner unreachable: ${owner} (${j.affinityKey})`,
        });
      } else if ((free.get(owner) ?? 0) <= 0) {
        unassigned.push({
          jobId: j.jobId,
          reason: `affinity owner at capacity: ${owner} (${j.affinityKey})`,
        });
      } else {
        assignments.push({
          jobId: j.jobId,
          serverId: owner,
          reason: `affinity ${j.affinityKey} -> ${owner}`,
        });
        take(owner);
      }
      continue;
    }
    const pick = policyPick();
    if (!pick) {
      unassigned.push({ jobId: j.jobId, reason: 'no capacity on any eligible server' });
      continue;
    }
    assignments.push({ jobId: j.jobId, serverId: pick.serverId, reason: pick.reason });
    take(pick.serverId);
    if (j.affinityKey) owners[j.affinityKey] = pick.serverId;
  }

  return { assignments, unassigned, affinityOwners: owners };
}
