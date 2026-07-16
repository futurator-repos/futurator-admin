import { describe, it, expect, vi, beforeEach } from 'vitest';

const { sendMock, listServersMock, flagMock, policyMock, ownersMock, setOwnersMock } = vi.hoisted(
  () => ({
    sendMock: vi.fn(),
    listServersMock: vi.fn(),
    flagMock: vi.fn(),
    policyMock: vi.fn(),
    ownersMock: vi.fn(),
    setOwnersMock: vi.fn(),
  }),
);

vi.mock('../../dynamo-client', () => ({
  docClient: { send: sendMock },
  TABLE_NAMES: { agentJobs: 'test-agent-jobs', servers: 'test-servers' },
}));

vi.mock('../../repositories/servers-repository', () => ({
  listServers: listServersMock,
}));

vi.mock('../dispatch-state', () => ({
  isServerAwareDispatchEnabled: flagMock,
  getDispatchPolicy: policyMock,
  getAffinityOwners: ownersMock,
  setAffinityOwners: setOwnersMock,
}));

import { runDispatchSweep } from '../server-dispatcher';
import { DEFAULT_DISPATCH_POLICY, type ComputeServer } from '../../types/compute-server';

interface CmdInput {
  TableName?: string;
  IndexName?: string;
  KeyConditionExpression?: string;
  FilterExpression?: string;
  ConditionExpression?: string;
  UpdateExpression?: string;
  ExpressionAttributeValues?: Record<string, unknown>;
  Select?: string;
  Key?: Record<string, unknown>;
  ScanIndexForward?: boolean;
  Limit?: number;
}

interface JobRow {
  jobId: string;
  createdAt: string;
  affinityKey?: string;
  pinnedServerId?: string;
  claimOwner?: string;
  claimToken?: string;
  claimExpiresAt?: string;
}

const inputOf = (cmd: unknown): CmdInput => (cmd as { input: CmdInput }).input;

function makeServer(overrides: Partial<ComputeServer> = {}): ComputeServer {
  return {
    serverId: 'srv-1',
    name: 'srv-1',
    provider: 'hetzner',
    serviceType: 'vm',
    region: 'fsn1',
    size: 'cax21',
    arch: 'arm64',
    status: 'ACTIVE',
    enabled: true,
    maxConcurrent: 4,
    costPerHour: 0.05,
    providerRef: {},
    enrollTokenHash: 'hash',
    lastHeartbeatAt: new Date(Date.now() - 5_000).toISOString(),
    activeCount: 0,
    createdAt: '2026-07-16T00:00:00.000Z',
    updatedAt: '2026-07-16T00:00:00.000Z',
    ...overrides,
  };
}

// Mutable per-test DDB fixture state consumed by the default send mock.
let unassignedPending: JobRow[] = [];
let staleAssigned: Record<string, JobRow[]> = {};
let runningJobs: JobRow[] = [];
let assignedPendingCount = 0;

const defaultSend = (cmd: unknown): Promise<Record<string, unknown>> => {
  const input = inputOf(cmd);
  if (input.UpdateExpression) return Promise.resolve({});
  if (input.IndexName === 'assignedServerId-status-index') {
    if (input.Select === 'COUNT') return Promise.resolve({ Count: assignedPendingCount });
    const sid = input.ExpressionAttributeValues?.[':sid'] as string;
    return Promise.resolve({ Items: staleAssigned[sid] ?? [] });
  }
  if (input.KeyConditionExpression === '#status = :running') {
    return Promise.resolve({ Items: runningJobs });
  }
  if (input.KeyConditionExpression === '#status = :pending') {
    return Promise.resolve({ Items: unassignedPending });
  }
  return Promise.resolve({});
};

function updateCalls(): CmdInput[] {
  return sendMock.mock.calls.map((c) => inputOf(c[0])).filter((i) => i.UpdateExpression);
}

function queryCalls(): CmdInput[] {
  return sendMock.mock.calls.map((c) => inputOf(c[0])).filter((i) => i.KeyConditionExpression);
}

beforeEach(() => {
  sendMock.mockReset();
  listServersMock.mockReset();
  flagMock.mockReset();
  policyMock.mockReset();
  ownersMock.mockReset();
  setOwnersMock.mockReset();

  unassignedPending = [];
  staleAssigned = {};
  runningJobs = [];
  assignedPendingCount = 0;

  flagMock.mockResolvedValue(true);
  policyMock.mockResolvedValue(DEFAULT_DISPATCH_POLICY);
  ownersMock.mockResolvedValue({});
  setOwnersMock.mockResolvedValue(undefined);
  listServersMock.mockResolvedValue([]);
  sendMock.mockImplementation(defaultSend);
});

describe('runDispatchSweep', () => {
  it('returns skipped with zero DDB writes when the flag is off', async () => {
    flagMock.mockResolvedValue(false);

    const summary = await runDispatchSweep();

    expect(summary).toEqual({
      skipped: true,
      assigned: 0,
      unassigned: 0,
      reassignedFromStale: 0,
      orphansReleased: 0,
    });
    expect(sendMock).not.toHaveBeenCalled();
    expect(listServersMock).not.toHaveBeenCalled();
  });

  it('assigns unassigned PENDING jobs to an eligible server with conditional writes', async () => {
    listServersMock.mockResolvedValue([makeServer()]);
    unassignedPending = [
      { jobId: 'job-1', createdAt: '2026-07-16T00:00:01.000Z' },
      { jobId: 'job-2', createdAt: '2026-07-16T00:00:02.000Z' },
    ];

    const summary = await runDispatchSweep();

    const updates = updateCalls();
    expect(updates).toHaveLength(2);
    for (const u of updates) {
      expect(u.TableName).toBe('test-agent-jobs');
      expect(u.ConditionExpression).toContain('attribute_not_exists(assignedServerId)');
      expect(u.UpdateExpression).toBe(
        'SET assignedServerId = :sid, assignedAt = :at, assignReason = :why',
      );
      expect(u.ExpressionAttributeValues?.[':sid']).toBe('srv-1');
      expect(u.ExpressionAttributeValues?.[':at']).toEqual(expect.any(String));
      expect(u.ExpressionAttributeValues?.[':why']).toEqual(expect.any(String));
    }
    expect(updates.map((u) => u.Key?.jobId)).toEqual(['job-1', 'job-2']);
    expect(summary).toMatchObject({ skipped: false, assigned: 2, unassigned: 0 });
  });

  it('does not assign to a server whose heartbeat is older than HEARTBEAT_FRESH_MS', async () => {
    // 90s old: past the 60s fresh window but not past the 120s stale window.
    listServersMock.mockResolvedValue([
      makeServer({ lastHeartbeatAt: new Date(Date.now() - 90_000).toISOString() }),
    ]);
    unassignedPending = [{ jobId: 'job-1', createdAt: '2026-07-16T00:00:01.000Z' }];

    const summary = await runDispatchSweep();

    expect(updateCalls()).toHaveLength(0);
    expect(summary.assigned).toBe(0);
    expect(summary.unassigned).toBe(1);
  });

  it('swallows ConditionalCheckFailedException on one job and continues the sweep', async () => {
    listServersMock.mockResolvedValue([makeServer()]);
    unassignedPending = [
      { jobId: 'job-1', createdAt: '2026-07-16T00:00:01.000Z' },
      { jobId: 'job-2', createdAt: '2026-07-16T00:00:02.000Z' },
    ];
    sendMock.mockImplementation((cmd: unknown) => {
      const input = inputOf(cmd);
      if (
        input.UpdateExpression?.startsWith('SET assignedServerId') &&
        input.Key?.jobId === 'job-1'
      ) {
        return Promise.reject(
          Object.assign(new Error('conditional check failed'), {
            name: 'ConditionalCheckFailedException',
          }),
        );
      }
      return defaultSend(cmd);
    });

    const summary = await runDispatchSweep();

    expect(updateCalls()).toHaveLength(2); // both writes attempted
    expect(summary.assigned).toBe(1);
    expect(summary.unassigned).toBe(1);
  });

  it('requeues non-affinity jobs from a stale server and pauses affinity jobs in place', async () => {
    listServersMock.mockResolvedValue([
      makeServer({
        serverId: 'srv-dead',
        lastHeartbeatAt: new Date(Date.now() - 300_000).toISOString(),
      }),
    ]);
    staleAssigned['srv-dead'] = [
      { jobId: 'job-a', createdAt: '2026-07-16T00:00:01.000Z' },
      { jobId: 'job-b', createdAt: '2026-07-16T00:00:02.000Z', affinityKey: 'plan:p1' },
    ];

    const summary = await runDispatchSweep();

    const updates = updateCalls();
    const requeue = updates.find((u) => u.Key?.jobId === 'job-a');
    expect(requeue?.UpdateExpression).toContain('REMOVE assignedServerId');
    expect(requeue?.UpdateExpression).toContain('assignedAt');
    expect(requeue?.ExpressionAttributeValues?.[':requeued']).toEqual(expect.any(String));

    const paused = updates.find((u) => u.Key?.jobId === 'job-b');
    expect(paused?.UpdateExpression).not.toContain('REMOVE');
    expect(paused?.ExpressionAttributeValues?.[':why']).toBe(
      'affinity owner unreachable: srv-dead',
    );

    expect(summary.reassignedFromStale).toBe(1);
  });

  it('releases expired RUNNING claims back to PENDING and leaves claim-less jobs untouched', async () => {
    runningJobs = [
      {
        jobId: 'job-r',
        createdAt: '2026-07-16T00:00:01.000Z',
        claimOwner: 'daemon-1',
        claimToken: 'tok',
        claimExpiresAt: new Date(Date.now() - 60_000).toISOString(),
      },
    ];

    const summary = await runDispatchSweep();

    // The RUNNING query itself must exclude jobs without claim fields.
    const runningQuery = queryCalls().find(
      (q) => q.KeyConditionExpression === '#status = :running',
    );
    expect(runningQuery?.FilterExpression).toBe(
      'attribute_exists(claimOwner) AND claimExpiresAt < :nowIso',
    );

    const updates = updateCalls();
    expect(updates).toHaveLength(1);
    const release = updates[0];
    expect(release.Key?.jobId).toBe('job-r');
    expect(release.UpdateExpression).toContain('SET #status = :pending');
    expect(release.UpdateExpression).toContain('REMOVE claimOwner, claimToken, claimExpiresAt');
    expect(release.ConditionExpression).toContain('claimExpiresAt < :nowIso');
    expect(summary.orphansReleased).toBe(1);
  });
});
