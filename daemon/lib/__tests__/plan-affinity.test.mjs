import { describe, it, expect } from 'vitest';
import { planAffinityStamp } from '../plan-affinity.mjs';

describe('planAffinityStamp', () => {
  it('stamps affinityKey `plan:<planId>` and nothing else with no parent', () => {
    const s = planAffinityStamp({ planId: 'p1' });
    expect(s).toEqual({ affinityKey: 'plan:p1' });
  });

  it('returns {} when planId is absent (never `plan:undefined`)', () => {
    expect(planAffinityStamp({})).toEqual({});
    expect(planAffinityStamp({ planId: '' })).toEqual({});
  });

  it('self-assigns when serverAware AND parent ran on THIS server', () => {
    const s = planAffinityStamp({
      planId: 'p1',
      parentJob: { jobId: 'j-parent', assignedServerId: 'srv_ec2_main' },
      serverId: 'srv_ec2_main',
      serverAware: true,
      nowIso: '2026-07-16T00:00:00.000Z',
    });
    expect(s.affinityKey).toBe('plan:p1');
    expect(s.assignedServerId).toBe('srv_ec2_main');
    expect(s.assignedAt).toBe('2026-07-16T00:00:00.000Z');
    expect(s.assignReason).toBe('inherited: plan affinity (parent j-parent)');
  });

  it('affinity-only when serverAware is OFF (legacy byte-for-byte)', () => {
    const s = planAffinityStamp({
      planId: 'p1',
      parentJob: { jobId: 'j-parent', assignedServerId: 'srv_ec2_main' },
      serverId: 'srv_ec2_main',
      serverAware: false,
    });
    expect(s).toEqual({ affinityKey: 'plan:p1' });
  });

  it('affinity-only when the parent has no assignedServerId', () => {
    const s = planAffinityStamp({
      planId: 'p1',
      parentJob: { jobId: 'j-parent' },
      serverId: 'srv_ec2_main',
      serverAware: true,
    });
    expect(s).toEqual({ affinityKey: 'plan:p1' });
  });

  it('affinity-only when the parent was assigned to a DIFFERENT server', () => {
    const s = planAffinityStamp({
      planId: 'p1',
      parentJob: { jobId: 'j-parent', assignedServerId: 'srv_local_mac' },
      serverId: 'srv_ec2_main',
      serverAware: true,
    });
    expect(s).toEqual({ affinityKey: 'plan:p1' });
  });

  it('falls back to unknown parent id in the reason', () => {
    const s = planAffinityStamp({
      planId: 'p1',
      parentJob: { assignedServerId: 'srv_ec2_main' },
      serverId: 'srv_ec2_main',
      serverAware: true,
      nowIso: '2026-07-16T00:00:00.000Z',
    });
    expect(s.assignReason).toBe('inherited: plan affinity (parent unknown)');
  });
});
