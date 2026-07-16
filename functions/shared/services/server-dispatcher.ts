/**
 * server-dispatcher.ts — Servers module (spec §5 / §11) — server-aware
 * dispatch orchestration. The I/O layer around the pure `planAssignments`
 * policy engine: reads eligible servers + the pending-job queue, stamps
 * `assignedServerId`/`assignedAt`/`assignReason` on agent jobs via conditional
 * writes, requeues jobs stranded on stale-heartbeat servers, and releases
 * expired claim leases (orphan recovery).
 *
 * Invoked inline after enqueue/policy changes and by the 1-minute sweeper
 * cron (`functions/cron/server-dispatch-sweeper.ts`). When flag
 * `dispatch.serverAware` is off the sweep short-circuits to `skipped: true`
 * without touching DynamoDB — legacy behavior byte-for-byte.
 */

import { QueryCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { docClient, TABLE_NAMES } from '../dynamo-client';
import { listServers } from '../repositories/servers-repository';
import {
  getAffinityOwners,
  getDispatchPolicy,
  isServerAwareDispatchEnabled,
  setAffinityOwners,
} from './dispatch-state';
import { planAssignments } from './dispatch-policy';
import type { EligibleServer, PendingJobLite } from './dispatch-policy';
import {
  HEARTBEAT_FRESH_MS,
  HEARTBEAT_STALE_MS,
  type ComputeServer,
} from '../types/compute-server';

export interface SweepSummary {
  skipped: boolean;
  assigned: number;
  unassigned: number;
  reassignedFromStale: number;
  orphansReleased: number;
}

const ASSIGNED_STATUS_INDEX = 'assignedServerId-status-index';
const STATUS_CREATED_INDEX = 'status-createdAt-index';
const UNASSIGNED_BATCH_LIMIT = 100;

interface AgentJobRow {
  jobId: string;
  createdAt: string;
  affinityKey?: string;
  pinnedServerId?: string;
}

function isConditionalCheckFailed(err: unknown): boolean {
  return err instanceof Error && err.name === 'ConditionalCheckFailedException';
}

/** Heartbeat age in ms; missing/unparseable heartbeat counts as infinitely old. */
function heartbeatAgeMs(server: ComputeServer, now: number): number {
  if (!server.lastHeartbeatAt) return Number.POSITIVE_INFINITY;
  const parsed = Date.parse(server.lastHeartbeatAt);
  return Number.isFinite(parsed) ? now - parsed : Number.POSITIVE_INFINITY;
}

/** Assigned-but-unclaimed backlog for one server (COUNT on the GSI). */
async function countAssignedPending(serverId: string): Promise<number> {
  const result = await docClient.send(
    new QueryCommand({
      TableName: TABLE_NAMES.agentJobs,
      IndexName: ASSIGNED_STATUS_INDEX,
      KeyConditionExpression: 'assignedServerId = :sid AND #status = :pending',
      ExpressionAttributeNames: { '#status': 'status' },
      ExpressionAttributeValues: { ':sid': serverId, ':pending': 'PENDING' },
      Select: 'COUNT',
    }),
  );
  return result.Count ?? 0;
}

/** PENDING jobs already assigned to a given server (stale-pass input). */
async function listAssignedPendingJobs(serverId: string): Promise<AgentJobRow[]> {
  const result = await docClient.send(
    new QueryCommand({
      TableName: TABLE_NAMES.agentJobs,
      IndexName: ASSIGNED_STATUS_INDEX,
      KeyConditionExpression: 'assignedServerId = :sid AND #status = :pending',
      ExpressionAttributeNames: { '#status': 'status' },
      ExpressionAttributeValues: { ':sid': serverId, ':pending': 'PENDING' },
    }),
  );
  return (result.Items as AgentJobRow[]) ?? [];
}

/** Oldest-first unassigned PENDING jobs (bounded batch per sweep). */
async function listUnassignedPendingJobs(): Promise<AgentJobRow[]> {
  const result = await docClient.send(
    new QueryCommand({
      TableName: TABLE_NAMES.agentJobs,
      IndexName: STATUS_CREATED_INDEX,
      KeyConditionExpression: '#status = :pending',
      FilterExpression: 'attribute_not_exists(assignedServerId)',
      ExpressionAttributeNames: { '#status': 'status' },
      ExpressionAttributeValues: { ':pending': 'PENDING' },
      ScanIndexForward: true,
      Limit: UNASSIGNED_BATCH_LIMIT,
    }),
  );
  return (result.Items as AgentJobRow[]) ?? [];
}

/** RUNNING jobs whose claim lease has expired (orphan-pass input). */
async function listExpiredRunningClaims(nowIso: string): Promise<AgentJobRow[]> {
  const result = await docClient.send(
    new QueryCommand({
      TableName: TABLE_NAMES.agentJobs,
      IndexName: STATUS_CREATED_INDEX,
      KeyConditionExpression: '#status = :running',
      FilterExpression: 'attribute_exists(claimOwner) AND claimExpiresAt < :nowIso',
      ExpressionAttributeNames: { '#status': 'status' },
      ExpressionAttributeValues: { ':running': 'RUNNING', ':nowIso': nowIso },
    }),
  );
  return (result.Items as AgentJobRow[]) ?? [];
}

export async function runDispatchSweep(): Promise<SweepSummary> {
  if (!(await isServerAwareDispatchEnabled())) {
    return {
      skipped: true,
      assigned: 0,
      unassigned: 0,
      reassignedFromStale: 0,
      orphansReleased: 0,
    };
  }

  const now = Date.now();
  const nowIso = new Date(now).toISOString();

  const servers = (await listServers()).filter((s) => s.status === 'ACTIVE');
  const fresh = servers.filter((s) => s.enabled && heartbeatAgeMs(s, now) < HEARTBEAT_FRESH_MS);

  // ── ASSIGNMENT PASS ──
  const eligible: EligibleServer[] = [];
  for (const s of fresh) {
    eligible.push({
      serverId: s.serverId,
      maxConcurrent: s.maxConcurrent,
      costPerHour: s.costPerHour,
      activeCount: s.activeCount ?? 0,
      assignedPending: await countAssignedPending(s.serverId),
    });
  }

  const jobs: PendingJobLite[] = (await listUnassignedPendingJobs()).map((r) => ({
    jobId: r.jobId,
    createdAt: r.createdAt,
    affinityKey: r.affinityKey,
    pinnedServerId: r.pinnedServerId,
  }));

  const plan = planAssignments({
    jobs,
    servers: eligible,
    policy: await getDispatchPolicy(),
    affinityOwners: await getAffinityOwners(),
  });

  let assigned = 0;
  let conditionLost = 0;
  for (const a of plan.assignments) {
    try {
      await docClient.send(
        new UpdateCommand({
          TableName: TABLE_NAMES.agentJobs,
          Key: { jobId: a.jobId },
          ConditionExpression: 'attribute_not_exists(assignedServerId) AND #status = :pending',
          UpdateExpression: 'SET assignedServerId = :sid, assignedAt = :at, assignReason = :why',
          ExpressionAttributeNames: { '#status': 'status' },
          ExpressionAttributeValues: {
            ':sid': a.serverId,
            ':at': nowIso,
            ':why': a.reason,
            ':pending': 'PENDING',
          },
        }),
      );
      assigned += 1;
    } catch (err) {
      // Someone else (inline dispatch, another sweep) won the write — skip.
      if (!isConditionalCheckFailed(err)) throw err;
      conditionLost += 1;
    }
  }

  // Persist affinity ownerships referenced this sweep (stamps lastSeenAt so
  // actively-used keys don't age out; untouched keys keep their timestamp).
  const seenOwners: Record<string, string> = {};
  for (const j of jobs) {
    if (j.affinityKey && plan.affinityOwners[j.affinityKey]) {
      seenOwners[j.affinityKey] = plan.affinityOwners[j.affinityKey];
    }
  }
  if (Object.keys(seenOwners).length > 0) {
    await setAffinityOwners(seenOwners);
  }

  // ── STALE PASS ── requeue non-affinity jobs stranded on unreachable
  // servers; affinity jobs pause in place with a visible reason (spec §5.1:
  // no silent reassignment — the repo state lives on that box).
  let reassignedFromStale = 0;
  const stale = servers.filter((s) => heartbeatAgeMs(s, now) > HEARTBEAT_STALE_MS);
  for (const server of stale) {
    const strandedJobs = await listAssignedPendingJobs(server.serverId);
    for (const job of strandedJobs) {
      try {
        if (job.affinityKey) {
          await docClient.send(
            new UpdateCommand({
              TableName: TABLE_NAMES.agentJobs,
              Key: { jobId: job.jobId },
              UpdateExpression: 'SET assignReason = :why',
              ExpressionAttributeValues: {
                ':why': `affinity owner unreachable: ${server.serverId}`,
              },
            }),
          );
        } else {
          await docClient.send(
            new UpdateCommand({
              TableName: TABLE_NAMES.agentJobs,
              Key: { jobId: job.jobId },
              ConditionExpression: 'assignedServerId = :sid AND #status = :pending',
              UpdateExpression: 'REMOVE assignedServerId, assignedAt SET assignReason = :requeued',
              ExpressionAttributeNames: { '#status': 'status' },
              ExpressionAttributeValues: {
                ':sid': server.serverId,
                ':pending': 'PENDING',
                ':requeued': `requeued: server ${server.serverId} heartbeat stale`,
              },
            }),
          );
          reassignedFromStale += 1;
        }
      } catch (err) {
        // Job moved (claimed/reassigned) between query and write — skip.
        if (!isConditionalCheckFailed(err)) throw err;
      }
    }
  }

  // ── ORPHAN PASS ── release expired claim leases back to PENDING so the
  // next sweep can reassign them. RUNNING jobs without claim fields (legacy
  // daemon writes) are excluded by the query filter and left untouched.
  let orphansReleased = 0;
  const expired = await listExpiredRunningClaims(nowIso);
  for (const job of expired) {
    try {
      await docClient.send(
        new UpdateCommand({
          TableName: TABLE_NAMES.agentJobs,
          Key: { jobId: job.jobId },
          ConditionExpression: '#status = :running AND claimExpiresAt < :nowIso',
          UpdateExpression: 'SET #status = :pending REMOVE claimOwner, claimToken, claimExpiresAt',
          ExpressionAttributeNames: { '#status': 'status' },
          ExpressionAttributeValues: {
            ':running': 'RUNNING',
            ':pending': 'PENDING',
            ':nowIso': nowIso,
          },
        }),
      );
      orphansReleased += 1;
    } catch (err) {
      // Lease renewed or job finished between query and write — skip.
      if (!isConditionalCheckFailed(err)) throw err;
    }
  }

  return {
    skipped: false,
    assigned,
    unassigned: plan.unassigned.length + conditionLost,
    reassignedFromStale,
    orphansReleased,
  };
}
