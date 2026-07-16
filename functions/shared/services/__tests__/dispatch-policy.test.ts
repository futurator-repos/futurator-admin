import { describe, it, expect } from 'vitest';
import { planAssignments, type EligibleServer, type PendingJobLite } from '../dispatch-policy';

const srv = (id: string, o: Partial<EligibleServer> = {}): EligibleServer => ({
  serverId: id,
  maxConcurrent: 2,
  costPerHour: 0.01,
  activeCount: 0,
  assignedPending: 0,
  ...o,
});
const job = (id: string, o: Partial<PendingJobLite> = {}): PendingJobLite => ({
  jobId: id,
  createdAt: `2026-07-16T00:00:0${id.slice(-1)}Z`,
  ...o,
});
const policy = (mode: 'priority' | 'weighted' | 'cheapest', o = {}) => ({
  mode,
  priorityOrder: [],
  weights: {},
  updatedAt: '',
  ...o,
});

describe('priority mode', () => {
  it('fills the first server to cap, overflows to the next', () => {
    const r = planAssignments({
      jobs: [job('j1'), job('j2'), job('j3')],
      servers: [srv('srv_a'), srv('srv_b')],
      policy: policy('priority', { priorityOrder: ['srv_a', 'srv_b'] }),
      affinityOwners: {},
    });
    expect(r.assignments.map((a) => [a.jobId, a.serverId])).toEqual([
      ['j1', 'srv_a'],
      ['j2', 'srv_a'],
      ['j3', 'srv_b'],
    ]);
  });

  it('counts activeCount + assignedPending against the cap', () => {
    const r = planAssignments({
      jobs: [job('j1')],
      servers: [srv('srv_a', { activeCount: 1, assignedPending: 1 }), srv('srv_b')],
      policy: policy('priority', { priorityOrder: ['srv_a', 'srv_b'] }),
      affinityOwners: {},
    });
    expect(r.assignments[0].serverId).toBe('srv_b');
  });

  it('servers missing from priorityOrder go last', () => {
    const r = planAssignments({
      jobs: [job('j1')],
      servers: [srv('srv_new'), srv('srv_a')],
      policy: policy('priority', { priorityOrder: ['srv_a'] }),
      affinityOwners: {},
    });
    expect(r.assignments[0].serverId).toBe('srv_a');
  });
});

describe('weighted mode', () => {
  it('splits a batch by weights ("half google half oracle")', () => {
    const r = planAssignments({
      jobs: ['j1', 'j2', 'j3', 'j4', 'j5', 'j6'].map((j) => job(j)),
      servers: [srv('srv_gcp', { maxConcurrent: 6 }), srv('srv_oracle', { maxConcurrent: 6 })],
      policy: policy('weighted', { weights: { srv_gcp: 50, srv_oracle: 50 } }),
      affinityOwners: {},
    });
    const byServer = (id: string) => r.assignments.filter((a) => a.serverId === id).length;
    expect(byServer('srv_gcp')).toBe(3);
    expect(byServer('srv_oracle')).toBe(3);
  });

  it('respects caps even when weights say otherwise', () => {
    const r = planAssignments({
      jobs: ['j1', 'j2', 'j3', 'j4'].map((j) => job(j)),
      servers: [srv('srv_a', { maxConcurrent: 1 }), srv('srv_b', { maxConcurrent: 6 })],
      policy: policy('weighted', { weights: { srv_a: 90, srv_b: 10 } }),
      affinityOwners: {},
    });
    expect(r.assignments.filter((a) => a.serverId === 'srv_a').length).toBe(1);
    expect(r.assignments.filter((a) => a.serverId === 'srv_b').length).toBe(3);
  });

  it('a server with weight 0 or absent gets nothing while others have capacity', () => {
    const r = planAssignments({
      jobs: [job('j1'), job('j2')],
      servers: [srv('srv_a'), srv('srv_b')],
      policy: policy('weighted', { weights: { srv_a: 100 } }),
      affinityOwners: {},
    });
    expect(r.assignments.every((a) => a.serverId === 'srv_a')).toBe(true);
  });
});

describe('cheapest mode', () => {
  it('fills cheapest first (oracle $0 soaks up work)', () => {
    const r = planAssignments({
      jobs: [job('j1'), job('j2'), job('j3')],
      servers: [srv('srv_hetzner', { costPerHour: 0.01 }), srv('srv_oracle', { costPerHour: 0 })],
      policy: policy('cheapest'),
      affinityOwners: {},
    });
    expect(r.assignments.map((a) => a.serverId)).toEqual([
      'srv_oracle',
      'srv_oracle',
      'srv_hetzner',
    ]);
  });
});

describe('affinity', () => {
  it('first job of a key claims ownership via policy; siblings follow', () => {
    const r = planAssignments({
      jobs: [job('j1', { affinityKey: 'plan:p1' }), job('j2', { affinityKey: 'plan:p1' })],
      servers: [srv('srv_a', { maxConcurrent: 6 }), srv('srv_b', { maxConcurrent: 6 })],
      policy: policy('priority', { priorityOrder: ['srv_a', 'srv_b'] }),
      affinityOwners: {},
    });
    expect(r.assignments.every((a) => a.serverId === 'srv_a')).toBe(true);
    expect(r.affinityOwners['plan:p1']).toBe('srv_a');
  });

  it('existing owner is honored even if policy prefers another server', () => {
    const r = planAssignments({
      jobs: [job('j1', { affinityKey: 'plan:p1' })],
      servers: [srv('srv_a'), srv('srv_b')],
      policy: policy('priority', { priorityOrder: ['srv_a', 'srv_b'] }),
      affinityOwners: { 'plan:p1': 'srv_b' },
    });
    expect(r.assignments[0].serverId).toBe('srv_b');
  });

  it('owner at capacity => job waits (never reassigned to another server)', () => {
    const r = planAssignments({
      jobs: [job('j1', { affinityKey: 'plan:p1' })],
      servers: [srv('srv_a'), srv('srv_b', { activeCount: 2 })],
      policy: policy('priority', { priorityOrder: ['srv_a'] }),
      affinityOwners: { 'plan:p1': 'srv_b' },
    });
    expect(r.assignments).toHaveLength(0);
    expect(r.unassigned[0].reason).toContain('affinity owner at capacity');
  });

  it('owner not in eligible set => job pauses with visible reason', () => {
    const r = planAssignments({
      jobs: [job('j1', { affinityKey: 'plan:p1' })],
      servers: [srv('srv_a')],
      policy: policy('priority', { priorityOrder: ['srv_a'] }),
      affinityOwners: { 'plan:p1': 'srv_dead' },
    });
    expect(r.assignments).toHaveLength(0);
    expect(r.unassigned[0].reason).toContain('affinity owner unreachable');
  });
});

describe('pinning', () => {
  it('pinnedServerId bypasses policy', () => {
    const r = planAssignments({
      jobs: [job('j1', { pinnedServerId: 'srv_b' })],
      servers: [srv('srv_a'), srv('srv_b')],
      policy: policy('priority', { priorityOrder: ['srv_a'] }),
      affinityOwners: {},
    });
    expect(r.assignments[0].serverId).toBe('srv_b');
  });

  it('pinned server unavailable => job waits', () => {
    const r = planAssignments({
      jobs: [job('j1', { pinnedServerId: 'srv_gone' })],
      servers: [srv('srv_a')],
      policy: policy('priority'),
      affinityOwners: {},
    });
    expect(r.unassigned[0].reason).toContain('pinned server unavailable');
  });
});

describe('exhaustion', () => {
  it('no capacity anywhere => all jobs stay queued', () => {
    const r = planAssignments({
      jobs: [job('j1')],
      servers: [srv('srv_a', { activeCount: 2 })],
      policy: policy('priority'),
      affinityOwners: {},
    });
    expect(r.assignments).toHaveLength(0);
    expect(r.unassigned[0].reason).toContain('no capacity');
  });

  it('every assignment carries a human-readable reason', () => {
    const r = planAssignments({
      jobs: [job('j1')],
      servers: [srv('srv_a')],
      policy: policy('priority', { priorityOrder: ['srv_a'] }),
      affinityOwners: {},
    });
    expect(r.assignments[0].reason).toMatch(/priority/);
  });
});
