import { describe, it, expect } from 'vitest';
import { deriveServerState, disableBehaviour } from '../server-state';
import type { ComputeServer } from '@/types/servers';

const NOW = Date.parse('2026-07-17T12:00:00Z');
const ago = (ms: number) => new Date(NOW - ms).toISOString();

const server = (o: Partial<ComputeServer> = {}): ComputeServer =>
  ({
    serverId: 'srv_gcp_a1',
    name: 'box',
    provider: 'gcp',
    serviceType: 'vm',
    region: 'europe-west3-a',
    size: 'e2-medium',
    arch: 'x86_64',
    status: 'ACTIVE',
    enabled: true,
    maxConcurrent: 2,
    costPerHour: 0.038,
    providerRef: {},
    createdAt: '2026-07-17T00:00:00Z',
    updatedAt: '2026-07-17T00:00:00Z',
    ...o,
  }) as ComputeServer;

describe('deriveServerState — liveness, not just lifecycle', () => {
  it('the bug this exists for: ACTIVE + never heartbeated reads UNREACHABLE, not ACTIVE', () => {
    // srv_ec2_main was seeded ACTIVE for an instance that does not exist in the
    // account. The card claimed ACTIVE next to "last seen never".
    const ec2 = server({ provider: 'aws', status: 'ACTIVE', lastHeartbeatAt: undefined });
    const state = deriveServerState(ec2, NOW);
    expect(state.label).toBe('UNREACHABLE');
    expect(state.tone).toBe('warning');
    expect(state.help).toMatch(/never reported in/i);
  });

  it('ACTIVE only when a heartbeat landed within 60s — the dispatcher rule', () => {
    expect(deriveServerState(server({ lastHeartbeatAt: ago(10_000) }), NOW).label).toBe('ACTIVE');
    expect(deriveServerState(server({ lastHeartbeatAt: ago(59_000) }), NOW).label).toBe('ACTIVE');
  });

  it('goes STALE past 60s — matching when the dispatcher stops assigning', () => {
    const state = deriveServerState(server({ lastHeartbeatAt: ago(90_000) }), NOW);
    expect(state.label).toBe('STALE');
    expect(state.tone).toBe('warning');
  });

  it('goes OFFLINE past 120s — matching when jobs get reassigned', () => {
    const state = deriveServerState(server({ lastHeartbeatAt: ago(300_000) }), NOW);
    expect(state.label).toBe('OFFLINE');
    expect(state.tone).toBe('destructive');
  });

  it('lifecycle states outrank liveness and explain what happens next', () => {
    expect(deriveServerState(server({ status: 'PROVISIONING' }), NOW).label).toBe('PROVISIONING');
    const boot = deriveServerState(server({ status: 'BOOTSTRAPPING' }), NOW);
    expect(boot.label).toBe('BOOTSTRAPPING');
    expect(boot.help).toMatch(/becomes ACTIVE/i);
    expect(deriveServerState(server({ status: 'PAUSED' }), NOW).label).toBe('PAUSED');
  });

  it('ERROR surfaces the provider’s own message', () => {
    const state = deriveServerState(
      server({ status: 'ERROR', statusMessage: 'out of host capacity' }),
      NOW,
    );
    expect(state.label).toBe('ERROR');
    expect(state.help).toBe('out of host capacity');
  });

  it('every state carries help text — the badge is never unexplained', () => {
    const statuses: ComputeServer['status'][] = [
      'PROVISIONING',
      'BOOTSTRAPPING',
      'ACTIVE',
      'PAUSED',
      'ERROR',
      'DEPROVISIONING',
      'DELETED',
    ];
    for (const status of statuses) {
      expect(deriveServerState(server({ status }), NOW).help.length).toBeGreaterThan(20);
    }
  });
});

describe('disableBehaviour — disable means different things per provider', () => {
  it('GCP: disabling really pauses billing', () => {
    const b = disableBehaviour(server({ provider: 'gcp' }));
    expect(b.stopsBilling).toBe(true);
    expect(b.costWarning).toBeUndefined();
    expect(b.help).toMatch(/billing pauses/i);
  });

  it('Hetzner/Oracle: disabling does NOT save money, and says so', () => {
    for (const provider of ['hetzner', 'oracle'] as const) {
      const b = disableBehaviour(server({ provider }));
      expect(b.stopsBilling).toBe(false);
      expect(b.costWarning).toMatch(/Destroy/);
    }
  });

  it('local/aws: no machine to manage from here, no false cost warning', () => {
    for (const provider of ['local', 'aws'] as const) {
      const b = disableBehaviour(server({ provider }));
      expect(b.stopsBilling).toBe(false);
      expect(b.costWarning).toBeUndefined();
    }
  });
});
