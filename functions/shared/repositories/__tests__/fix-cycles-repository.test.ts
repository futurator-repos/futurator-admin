import { describe, it, expect, vi, beforeEach } from 'vitest';

const { sendMock } = vi.hoisted(() => ({ sendMock: vi.fn() }));

vi.mock('../../dynamo-client', () => ({
  docClient: { send: sendMock },
  TABLE_NAMES: { fixCycles: 'test-fix-cycles' },
}));

import {
  getCycle,
  recordAttempt,
  markExhausted,
  cycleKey,
  FIX_CYCLE_HARD_CAP,
} from '../fix-cycles-repository';

function extract(command: unknown) {
  return (command as { input: Record<string, unknown> }).input;
}

beforeEach(() => {
  sendMock.mockReset();
});

describe('FIX_CYCLE_HARD_CAP', () => {
  it('is 3 per §9.5 RESOLVED', () => {
    expect(FIX_CYCLE_HARD_CAP).toBe(3);
  });
});

describe('cycleKey', () => {
  it('joins planId and waveNumber with #', () => {
    expect(cycleKey('plan_dino7_x', 4)).toBe('plan_dino7_x#4');
  });
});

describe('getCycle', () => {
  it('returns null when row is absent', async () => {
    sendMock.mockResolvedValue({});
    expect(await getCycle('plan_x', 1)).toBeNull();
  });

  it('returns the row keyed by cycleKey', async () => {
    sendMock.mockResolvedValue({
      Item: {
        cycleKey: 'plan_x#1',
        planId: 'plan_x',
        waveNumber: 1,
        attempts: 2,
        status: 'open',
      },
    });
    const row = await getCycle('plan_x', 1);
    expect(row?.attempts).toBe(2);
    expect(extract(sendMock.mock.calls[0][0]).Key).toEqual({ cycleKey: 'plan_x#1' });
  });
});

describe('recordAttempt', () => {
  it('increments attempts and appends sessionId, returns ALL_NEW row', async () => {
    sendMock.mockResolvedValue({
      Attributes: {
        cycleKey: 'plan_x#3',
        planId: 'plan_x',
        waveNumber: 3,
        attempts: 1,
        lastAttemptAt: '2026-05-27T20:00:00.000Z',
        sessionIds: ['sid-1'],
        status: 'open',
        expiresAt: 1234567890,
      },
    });
    const row = await recordAttempt('plan_x', 3, 'sid-1');
    expect(row.attempts).toBe(1);
    expect(row.sessionIds).toEqual(['sid-1']);
    const input = extract(sendMock.mock.calls[0][0]);
    expect(input.Key).toEqual({ cycleKey: 'plan_x#3' });
    expect(input.ReturnValues).toBe('ALL_NEW');
    expect(input.UpdateExpression).toContain('ADD attempts :one');
    expect(input.UpdateExpression).toContain('list_append');
  });
});

describe('markExhausted', () => {
  it('flips status to exhausted with conditional existence', async () => {
    sendMock.mockResolvedValue({});
    await markExhausted('plan_x', 2);
    const input = extract(sendMock.mock.calls[0][0]);
    expect(input.UpdateExpression).toContain('#status = :exhausted');
    expect(input.ConditionExpression).toBe('attribute_exists(cycleKey)');
    expect(input.ExpressionAttributeValues).toMatchObject({ ':exhausted': 'exhausted' });
  });
});
