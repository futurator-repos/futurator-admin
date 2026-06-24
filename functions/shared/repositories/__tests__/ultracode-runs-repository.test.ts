import { describe, it, expect, vi, beforeEach } from 'vitest';

const { sendMock } = vi.hoisted(() => ({ sendMock: vi.fn() }));

vi.mock('../../dynamo-client', () => ({
  docClient: { send: sendMock },
  TABLE_NAMES: { ultracodeRuns: 'test-ultracode-runs' },
}));

import { createRun, getRun, listRunsByOperator, updateRun } from '../ultracode-runs-repository';
import { buildUltracodeRun, createUltracodeRunSchema } from '../../schemas/ultracode-run-schema';

function input(command: unknown) {
  return (command as { input: Record<string, unknown> }).input;
}

const NOW = new Date('2026-06-24T12:00:00.000Z');

beforeEach(() => sendMock.mockReset());

describe('createUltracodeRunSchema', () => {
  it('applies defaults and enforces a minimum intent length', () => {
    const ok = createUltracodeRunSchema.safeParse({ intent: 'build me a pacman game' });
    expect(ok.success).toBe(true);
    expect(ok.success && ok.data).toMatchObject({
      target: 'greenfield',
      rigor: 'production',
      reps: 5,
    });

    expect(createUltracodeRunSchema.safeParse({ intent: 'short' }).success).toBe(false);
    expect(createUltracodeRunSchema.safeParse({ intent: 'long enough', reps: 9 }).success).toBe(
      false,
    );
  });
});

describe('buildUltracodeRun', () => {
  it('constructs a QUEUED row with the confound stamped and a 90-day TTL', () => {
    const parsed = createUltracodeRunSchema.parse({
      intent: 'plan the onboarding flow',
      rigor: 'mvp',
    });
    const run = buildUltracodeRun(parsed, { runId: 'r1', operatorId: 'op-1', now: NOW });
    expect(run.status).toBe('QUEUED');
    expect(run.case1Status).toBe('PENDING');
    expect(run.case2Status).toBe('PENDING');
    expect(run.confound).toBe('case2-cost-tiered-chain');
    expect(run.expiresAt).toBe(Math.floor(NOW.getTime() / 1000) + 90 * 24 * 60 * 60);
    expect(run.createdAt).toBe(NOW.toISOString());
  });
});

describe('repository round-trip', () => {
  it('createRun PUTs the item to the right table', async () => {
    sendMock.mockResolvedValue({});
    const run = buildUltracodeRun(
      createUltracodeRunSchema.parse({ intent: 'a real intent here' }),
      { runId: 'r2', operatorId: 'op-2', now: NOW },
    );
    await createRun(run);
    expect(input(sendMock.mock.calls[0][0])).toMatchObject({
      TableName: 'test-ultracode-runs',
      Item: run,
    });
  });

  it('getRun returns null when absent, the row when present', async () => {
    sendMock.mockResolvedValueOnce({});
    expect(await getRun('missing')).toBeNull();
    sendMock.mockResolvedValueOnce({ Item: { runId: 'r3', status: 'COMPLETE' } });
    expect(await getRun('r3')).toMatchObject({ runId: 'r3' });
  });

  it('listRunsByOperator queries the operator GSI newest-first and maps to summaries', async () => {
    sendMock.mockResolvedValue({
      Items: [
        {
          runId: 'r4',
          intent: 'i',
          target: 'greenfield',
          rigor: 'mvp',
          reps: 5,
          status: 'COMPLETE',
          case1Status: 'HALTED',
          case2Status: 'COMPLETE',
          structuralScore: 0.5,
          createdAt: NOW.toISOString(),
          scorecard: { huge: true },
        },
      ],
    });
    const out = await listRunsByOperator('op-1');
    const cmd = input(sendMock.mock.calls[0][0]);
    expect(cmd.IndexName).toBe('operator-createdAt-index');
    expect(cmd.ScanIndexForward).toBe(false);
    // summary must NOT carry the heavy scorecard payload
    expect(out[0]).not.toHaveProperty('scorecard');
    expect(out[0]).toMatchObject({ runId: 'r4', structuralScore: 0.5 });
  });

  it('updateRun builds a SET expression and always bumps updatedAt', async () => {
    sendMock.mockResolvedValue({});
    await updateRun('r5', { status: 'SCORING', structuralScore: 0.8 });
    const cmd = input(sendMock.mock.calls[0][0]);
    expect(cmd.UpdateExpression).toContain('#status = :status');
    expect(cmd.UpdateExpression).toContain('#updatedAt = :updatedAt');
    expect((cmd.ExpressionAttributeNames as Record<string, string>)['#status']).toBe('status');
  });

  it('updateRun no-ops on an empty patch (only undefined fields)', async () => {
    await updateRun('r6', { errorMessage: undefined });
    expect(sendMock).not.toHaveBeenCalled();
  });
});
