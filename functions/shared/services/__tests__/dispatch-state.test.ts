import { describe, it, expect, vi, beforeEach } from 'vitest';

const { getFlagMock, setFlagMock } = vi.hoisted(() => ({
  getFlagMock: vi.fn(),
  setFlagMock: vi.fn(),
}));

vi.mock('../../repositories/agent-flags-repository', () => ({
  getFlag: getFlagMock,
  setFlag: setFlagMock,
  AGENT_FLAG_KEYS: {
    paused: 'agent.paused',
    maxConcurrentEc2: 'concurrency.maxConcurrent.ec2',
    maxConcurrentLocal: 'concurrency.maxConcurrent.local',
    dispatchServerAware: 'dispatch.serverAware',
    dispatchPolicy: 'dispatch.policy',
    dispatchAffinityOwners: 'dispatch.affinityOwners',
  },
}));

import {
  getDispatchPolicy,
  setDispatchPolicy,
  isServerAwareDispatchEnabled,
  getAffinityOwners,
  setAffinityOwners,
} from '../dispatch-state';
import { DEFAULT_DISPATCH_POLICY } from '../../types/compute-server';

function flagRow(value: string, updatedAt = '2026-07-16T00:00:00.000Z') {
  return { flagName: 'x', value, updatedBy: 'system', updatedAt };
}

beforeEach(() => {
  getFlagMock.mockReset();
  setFlagMock.mockReset();
});

describe('getDispatchPolicy', () => {
  it('falls back to the default policy when unset', async () => {
    getFlagMock.mockResolvedValue(null);
    const policy = await getDispatchPolicy();
    expect(policy).toEqual(DEFAULT_DISPATCH_POLICY);
  });

  it('falls back to the default policy when the stored value is corrupt', async () => {
    getFlagMock.mockResolvedValue(flagRow('not json'));
    const policy = await getDispatchPolicy();
    expect(policy).toEqual(DEFAULT_DISPATCH_POLICY);
  });

  it('falls back to the default policy when the stored value fails schema validation', async () => {
    getFlagMock.mockResolvedValue(flagRow(JSON.stringify({ mode: 'random' })));
    const policy = await getDispatchPolicy();
    expect(policy).toEqual(DEFAULT_DISPATCH_POLICY);
  });
});

describe('setDispatchPolicy / getDispatchPolicy round-trip', () => {
  it('reads back exactly what was written', async () => {
    const written = {
      mode: 'weighted' as const,
      priorityOrder: [],
      weights: { srv_a: 50, srv_b: 50 },
    };
    setFlagMock.mockResolvedValue(flagRow(JSON.stringify(written), '2026-07-16T01:00:00.000Z'));
    const result = await setDispatchPolicy(written);
    expect(result).toEqual({ ...written, updatedAt: '2026-07-16T01:00:00.000Z' });
    expect(setFlagMock).toHaveBeenCalledWith(
      'dispatch.policy',
      JSON.stringify(written),
      expect.any(String),
    );

    getFlagMock.mockResolvedValue(flagRow(JSON.stringify(written), '2026-07-16T01:00:00.000Z'));
    const readBack = await getDispatchPolicy();
    expect(readBack).toEqual({ ...written, updatedAt: '2026-07-16T01:00:00.000Z' });
  });
});

describe('isServerAwareDispatchEnabled', () => {
  it('defaults to false when the flag is unset', async () => {
    getFlagMock.mockResolvedValue(null);
    expect(await isServerAwareDispatchEnabled()).toBe(false);
  });

  it('defaults to false for any value other than the string "true"', async () => {
    getFlagMock.mockResolvedValue(flagRow('yes'));
    expect(await isServerAwareDispatchEnabled()).toBe(false);
  });

  it('is true only when the flag value is exactly "true"', async () => {
    getFlagMock.mockResolvedValue(flagRow('true'));
    expect(await isServerAwareDispatchEnabled()).toBe(true);
  });
});

describe('affinity owners', () => {
  it('returns an empty map when unset', async () => {
    getFlagMock.mockResolvedValue(null);
    expect(await getAffinityOwners()).toEqual({});
  });

  it('round-trips a flat serverId map', async () => {
    let stored: string | null = null;
    setFlagMock.mockImplementation(async (_key: string, value: string) => {
      stored = value;
      return flagRow(value);
    });
    getFlagMock.mockImplementation(async () => (stored ? flagRow(stored) : null));

    await setAffinityOwners({ 'plan:p1': 'srv_a' });
    const owners = await getAffinityOwners();
    expect(owners).toEqual({ 'plan:p1': 'srv_a' });
  });

  it('prunes entries whose lastSeenAt is older than 7 days on write, keeping fresh ones', async () => {
    const now = Date.now();
    const eightDaysAgo = new Date(now - 8 * 24 * 60 * 60 * 1000).toISOString();
    const justNow = new Date(now).toISOString();
    const existing = {
      'plan:old': { serverId: 'srv_x', lastSeenAt: eightDaysAgo },
      'plan:fresh': { serverId: 'srv_y', lastSeenAt: justNow },
    };

    let stored = JSON.stringify(existing);
    getFlagMock.mockImplementation(async () => flagRow(stored));
    setFlagMock.mockImplementation(async (_key: string, value: string) => {
      stored = value;
      return flagRow(value);
    });

    // Write an empty incoming map — nothing new touched this cycle, but the
    // write should still prune anything stale from prior cycles.
    await setAffinityOwners({});

    const owners = await getAffinityOwners();
    expect(owners).toEqual({ 'plan:fresh': 'srv_y' });
  });
});
