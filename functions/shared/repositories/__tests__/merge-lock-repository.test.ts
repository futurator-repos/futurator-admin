/**
 * merge-lock-repository.test.ts — Pipeline v2 Phase 2-B / Story 2-B-4-1 (PR-87).
 *
 * Unit-tests the lock logic against a mocked DDB client. The real DDB
 * conditional-check semantics are exercised in integration tests (out
 * of scope here).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the DDB client BEFORE importing the repository so the repository
// picks up the mocked docClient.
const sendMock = vi.fn();
vi.mock('../../dynamo-client', () => ({
  docClient: { send: (...args: unknown[]) => sendMock(...args) },
  TABLE_NAMES: { attentionItems: 'futurator-attention-items' },
}));

import {
  acquireMergeLock,
  releaseMergeLock,
  getMergeLock,
  MERGE_LOCK_TTL_MS,
} from '../merge-lock-repository';

beforeEach(() => {
  sendMock.mockReset();
});

describe('acquireMergeLock', () => {
  it('returns acquired=true when DDB Put succeeds', async () => {
    sendMock.mockResolvedValueOnce({});
    const result = await acquireMergeLock({
      projectSlug: 'songster',
      holder: 'daemon-1:pln-1',
      now: () => 1_700_000_000_000,
    });
    expect(result.acquired).toBe(true);
    expect(result.row?.holder).toBe('daemon-1:pln-1');
    expect(sendMock).toHaveBeenCalledTimes(1);
  });

  it('returns acquired=false + current holder when ConditionalCheckFailed', async () => {
    const err = new Error('cond');
    (err as Error & { name: string }).name = 'ConditionalCheckFailedException';
    sendMock.mockRejectedValueOnce(err);
    sendMock.mockResolvedValueOnce({
      Item: {
        planId: 'LOCK#songster',
        itemId: 'MERGE',
        holder: 'daemon-2:other-plan',
        acquiredAt: '2026-05-15T22:00:00Z',
        ttl: Math.floor(1_700_000_300_000 / 1000),
        kind: 'merge-lock',
      },
    });
    const result = await acquireMergeLock({
      projectSlug: 'songster',
      holder: 'daemon-1:pln-1',
      now: () => 1_700_000_000_000,
    });
    expect(result.acquired).toBe(false);
    expect(result.currentHolder).toBe('daemon-2:other-plan');
    expect(result.ttlRemainingSec).toBeGreaterThan(0);
  });

  it('uses 5-minute TTL', () => {
    expect(MERGE_LOCK_TTL_MS).toBe(5 * 60 * 1000);
  });

  it('rethrows non-conditional DDB errors', async () => {
    sendMock.mockRejectedValueOnce(new Error('throttled'));
    await expect(
      acquireMergeLock({ projectSlug: 'songster', holder: 'd1', now: () => 1 }),
    ).rejects.toThrow('throttled');
  });
});

describe('releaseMergeLock', () => {
  it('returns true on successful release', async () => {
    sendMock.mockResolvedValueOnce({});
    const result = await releaseMergeLock({ projectSlug: 'songster', holder: 'd1' });
    expect(result).toBe(true);
  });

  it('returns false when conditional check fails (not held by caller)', async () => {
    const { ConditionalCheckFailedException } = await import('@aws-sdk/client-dynamodb');
    const err = new ConditionalCheckFailedException({
      $metadata: {},
      message: 'cond',
    });
    sendMock.mockRejectedValueOnce(err);
    const result = await releaseMergeLock({ projectSlug: 'songster', holder: 'd1' });
    expect(result).toBe(false);
  });
});

describe('getMergeLock', () => {
  it('returns null when no row', async () => {
    sendMock.mockResolvedValueOnce({ Item: undefined });
    expect(await getMergeLock('songster')).toBeNull();
  });

  it('returns the row when present', async () => {
    sendMock.mockResolvedValueOnce({
      Item: {
        planId: 'LOCK#songster',
        itemId: 'MERGE',
        holder: 'd1',
        acquiredAt: 't',
        ttl: 1,
        kind: 'merge-lock',
      },
    });
    const row = await getMergeLock('songster');
    expect(row?.holder).toBe('d1');
  });
});
