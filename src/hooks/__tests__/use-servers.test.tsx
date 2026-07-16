/**
 * use-servers.test.tsx — Servers module (Task 20).
 *
 * Unit-tests the pure `heartbeatState` helper: derives fresh/stale/dead from
 * a server's `lastHeartbeatAt` against the spec §5 thresholds
 * (HEARTBEAT_FRESH_MS 60s, HEARTBEAT_STALE_MS 120s). The hooks themselves are
 * thin `api` wrappers (mirrors `use-queue-requests.ts`) — no separate mocked
 * coverage per the plan ("otherwise cover the pure helpers").
 */

import { describe, it, expect } from 'vitest';
import { heartbeatState } from '../use-servers';

describe('heartbeatState', () => {
  const now = 1_000_000;

  it('is fresh under 60s', () => {
    expect(heartbeatState(new Date(now - 1_000).toISOString(), now)).toBe('fresh');
    expect(heartbeatState(new Date(now - 59_000).toISOString(), now)).toBe('fresh');
  });

  it('is stale from 60s up to (not including) 120s', () => {
    expect(heartbeatState(new Date(now - 60_000).toISOString(), now)).toBe('stale');
    expect(heartbeatState(new Date(now - 61_000).toISOString(), now)).toBe('stale');
    expect(heartbeatState(new Date(now - 119_000).toISOString(), now)).toBe('stale');
  });

  it('is dead at 120s or beyond', () => {
    expect(heartbeatState(new Date(now - 120_000).toISOString(), now)).toBe('dead');
    expect(heartbeatState(new Date(now - 500_000).toISOString(), now)).toBe('dead');
  });

  it('is dead when there is no heartbeat yet', () => {
    expect(heartbeatState(undefined, now)).toBe('dead');
  });
});
