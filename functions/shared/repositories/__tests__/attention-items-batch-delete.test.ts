/**
 * Unit test for deleteAttentionItemsByPlan (2026-05-19).
 *
 * Verifies:
 *   - Empty planId short-circuits to 0 without DDB calls.
 *   - Pages through Query results until LastEvaluatedKey is gone.
 *   - Slices into batches of 25 (DDB BatchWriteItem hard cap).
 *   - Returns the total count of items deleted.
 *
 * We mock the docClient by intercepting send() and reading the constructor
 * name of the incoming command, so we don't depend on the SDK's internal
 * type machinery.
 */

import { describe, expect, it, vi, beforeEach } from 'vitest';

const sentCommands: Array<{ name: string; input: unknown }> = [];
const sendMock = vi.fn();

vi.mock('@aws-sdk/lib-dynamodb', async () => {
  // Pass-through for command constructors — we just need them to expose
  // their input + constructor name. The real lib-dynamodb command classes
  // do exactly this, but importing them pulls in the AWS SDK which is
  // heavy and noisy under vitest. Synthesize lightweight stubs.
  class FakeCommand {
    constructor(public input: unknown) {}
  }
  return {
    QueryCommand: class extends FakeCommand {},
    BatchWriteCommand: class extends FakeCommand {},
    GetCommand: class extends FakeCommand {},
    PutCommand: class extends FakeCommand {},
    UpdateCommand: class extends FakeCommand {},
  };
});

vi.mock('@aws-sdk/client-dynamodb', () => ({
  ConditionalCheckFailedException: class extends Error {
    name = 'ConditionalCheckFailedException';
  },
}));

vi.mock('../../dynamo-client', () => ({
  TABLE_NAMES: { attentionItems: 'futurator-attention-items' },
  docClient: {
    send: (cmd: { constructor: { name: string }; input: unknown }) => {
      sentCommands.push({ name: cmd.constructor.name, input: cmd.input });
      return sendMock(cmd);
    },
  },
}));

import { deleteAttentionItemsByPlan } from '../attention-items-repository';

beforeEach(() => {
  sentCommands.length = 0;
  sendMock.mockReset();
});

describe('deleteAttentionItemsByPlan', () => {
  it('returns 0 immediately when planId is empty', async () => {
    const n = await deleteAttentionItemsByPlan('');
    expect(n).toBe(0);
    expect(sendMock).not.toHaveBeenCalled();
  });

  it('returns 0 when no items match', async () => {
    sendMock.mockResolvedValueOnce({ Items: [], LastEvaluatedKey: undefined });
    const n = await deleteAttentionItemsByPlan('plan_empty');
    expect(n).toBe(0);
    // Just one QueryCommand, no BatchWriteCommand.
    expect(sentCommands.filter((c) => c.name === 'QueryCommand')).toHaveLength(1);
    expect(sentCommands.filter((c) => c.name === 'BatchWriteCommand')).toHaveLength(0);
  });

  it('batches 60 items into 3 BatchWriteCommand calls of 25/25/10', async () => {
    const items = Array.from({ length: 60 }, (_, i) => ({
      planId: 'plan_x',
      itemId: `item-${i}`,
    }));
    sendMock
      .mockResolvedValueOnce({ Items: items, LastEvaluatedKey: undefined })
      // 3 batches × 1 attempt (no UnprocessedItems).
      .mockResolvedValueOnce({ UnprocessedItems: {} })
      .mockResolvedValueOnce({ UnprocessedItems: {} })
      .mockResolvedValueOnce({ UnprocessedItems: {} });

    const n = await deleteAttentionItemsByPlan('plan_x');
    expect(n).toBe(60);
    const batches = sentCommands.filter((c) => c.name === 'BatchWriteCommand');
    expect(batches).toHaveLength(3);
    const sizes = batches.map(
      (b) =>
        (
          (b.input as { RequestItems: Record<string, unknown[]> }).RequestItems[
            'futurator-attention-items'
          ] as unknown[]
        ).length,
    );
    expect(sizes).toEqual([25, 25, 10]);
  });

  it('retries unprocessed items', async () => {
    const items = Array.from({ length: 3 }, (_, i) => ({
      planId: 'plan_y',
      itemId: `item-${i}`,
    }));
    sendMock
      .mockResolvedValueOnce({ Items: items, LastEvaluatedKey: undefined })
      // First batch returns 1 unprocessed; retry succeeds.
      .mockResolvedValueOnce({
        UnprocessedItems: {
          'futurator-attention-items': [
            { DeleteRequest: { Key: { planId: 'plan_y', itemId: 'item-2' } } },
          ],
        },
      })
      .mockResolvedValueOnce({ UnprocessedItems: {} });

    const n = await deleteAttentionItemsByPlan('plan_y');
    expect(n).toBe(3);
    expect(sentCommands.filter((c) => c.name === 'BatchWriteCommand')).toHaveLength(2);
  });

  it('pages through multiple Query results', async () => {
    sendMock
      .mockResolvedValueOnce({
        Items: [{ planId: 'plan_z', itemId: 'a' }],
        LastEvaluatedKey: { planId: 'plan_z', itemId: 'a' },
      })
      .mockResolvedValueOnce({ UnprocessedItems: {} })
      .mockResolvedValueOnce({
        Items: [{ planId: 'plan_z', itemId: 'b' }],
        LastEvaluatedKey: undefined,
      })
      .mockResolvedValueOnce({ UnprocessedItems: {} });

    const n = await deleteAttentionItemsByPlan('plan_z');
    expect(n).toBe(2);
    expect(sentCommands.filter((c) => c.name === 'QueryCommand')).toHaveLength(2);
    expect(sentCommands.filter((c) => c.name === 'BatchWriteCommand')).toHaveLength(2);
  });
});
