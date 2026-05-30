/**
 * Tests for the per-plan reduce lock (event-driven advancement, 2026-05-30).
 *
 * Verifies the conditional-write contract: acquire issues a guarded SET
 * (no live lock OR stale), returns null on ConditionalCheckFailedException,
 * and release issues a token-guarded REMOVE. The lock serializes the cron and
 * the reactive check-wave-completion endpoint so they never double-create a
 * wave-merge/next-wave job.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const sends: Array<{ input: unknown }> = [];
let nextSendImpl: (input: unknown) => unknown = () => ({});

vi.mock('../../dynamo-client', () => ({
  TABLE_NAMES: { plans: 'futurator-plans' },
  docClient: {
    send: (cmd: { input: unknown }) => {
      sends.push(cmd);
      return Promise.resolve(nextSendImpl(cmd.input));
    },
  },
}));

// UpdateCommand passthrough so we can inspect `.input`.
vi.mock('@aws-sdk/lib-dynamodb', () => ({
  UpdateCommand: class {
    input: unknown;
    constructor(input: unknown) {
      this.input = input;
    }
  },
  DeleteCommand: class {
    input: unknown;
    constructor(input: unknown) {
      this.input = input;
    }
  },
  GetCommand: class {
    constructor(public input: unknown) {}
  },
  PutCommand: class {
    constructor(public input: unknown) {}
  },
  QueryCommand: class {
    constructor(public input: unknown) {}
  },
  ScanCommand: class {
    constructor(public input: unknown) {}
  },
}));

const { acquirePlanReduceLock, releasePlanReduceLock } = await import('../plan-repository');

beforeEach(() => {
  sends.length = 0;
  nextSendImpl = () => ({});
});

describe('acquirePlanReduceLock', () => {
  it('issues a guarded SET (no-live-lock OR stale) and returns a token', async () => {
    const token = await acquirePlanReduceLock('plan_x', 1_000_000, 60_000);
    expect(token).toBeTruthy();
    expect(sends).toHaveLength(1);
    const input = sends[0].input as {
      ConditionExpression: string;
      UpdateExpression: string;
      ExpressionAttributeValues: Record<string, unknown>;
    };
    expect(input.UpdateExpression).toContain('reduceLockToken');
    expect(input.ConditionExpression).toContain('attribute_not_exists(reduceLockToken)');
    expect(input.ConditionExpression).toContain('reduceLockAt < :stale');
    // stale boundary = now - ttl
    expect(input.ExpressionAttributeValues[':stale']).toBe(940_000);
    expect(input.ExpressionAttributeValues[':now']).toBe(1_000_000);
  });

  it('returns null when the lock is already held (ConditionalCheckFailed)', async () => {
    nextSendImpl = () => {
      const e = new Error('held') as Error & { name: string };
      e.name = 'ConditionalCheckFailedException';
      throw e;
    };
    const token = await acquirePlanReduceLock('plan_x', 1_000_000);
    expect(token).toBeNull();
  });

  it('rethrows non-conditional errors', async () => {
    nextSendImpl = () => {
      throw new Error('throttled');
    };
    await expect(acquirePlanReduceLock('plan_x', 1)).rejects.toThrow('throttled');
  });
});

describe('releasePlanReduceLock', () => {
  it('issues a token-guarded REMOVE', async () => {
    await releasePlanReduceLock('plan_x', 'tok-123');
    expect(sends).toHaveLength(1);
    const input = sends[0].input as {
      UpdateExpression: string;
      ConditionExpression: string;
      ExpressionAttributeValues: Record<string, unknown>;
    };
    expect(input.UpdateExpression).toContain('REMOVE reduceLockToken');
    expect(input.ConditionExpression).toBe('reduceLockToken = :tok');
    expect(input.ExpressionAttributeValues[':tok']).toBe('tok-123');
  });

  it('swallows ConditionalCheckFailed (someone else holds/cleared it)', async () => {
    nextSendImpl = () => {
      const e = new Error('not ours') as Error & { name: string };
      e.name = 'ConditionalCheckFailedException';
      throw e;
    };
    await expect(releasePlanReduceLock('plan_x', 'tok')).resolves.toBeUndefined();
  });
});
