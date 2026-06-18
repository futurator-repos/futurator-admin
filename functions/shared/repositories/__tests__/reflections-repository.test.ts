/**
 * reflections-repository.test.ts — Skills Institution, Story 1.2.
 *
 * Covers markReflectionApplied: the conditional stamp + idempotency fallback.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const { sendMock } = vi.hoisted(() => ({ sendMock: vi.fn() }));

vi.mock('../../dynamo-client', () => ({
  docClient: { send: sendMock },
  TABLE_NAMES: { reflections: 'test-reflections' },
}));

import { markReflectionApplied } from '../reflections-repository';

function input(command: unknown) {
  return (command as { input: Record<string, unknown> }).input;
}

beforeEach(() => sendMock.mockReset());

describe('markReflectionApplied', () => {
  it('stamps appliedAt + outcome + commitSha under a conditional write', async () => {
    sendMock.mockResolvedValue({
      Attributes: { projectSlug: 'p', id: 'r', appliedAt: 'now', applyOutcome: 'applied' },
    });
    const out = await markReflectionApplied({
      projectSlug: 'p',
      id: 'r',
      outcome: 'applied',
      commitSha: 'abc123',
      appliedAt: '2026-06-17T10:00:00Z',
    });
    expect(out?.applyOutcome).toBe('applied');
    const cmd = input(sendMock.mock.calls[0][0]);
    expect(cmd.ConditionExpression).toBe(
      'attribute_exists(id) AND attribute_not_exists(appliedAt)',
    );
    expect(cmd.UpdateExpression).toContain('appliedAt = :now');
    expect(cmd.UpdateExpression).toContain('appliedCommitSha = :sha');
    expect(cmd.ExpressionAttributeValues).toMatchObject({
      ':now': '2026-06-17T10:00:00Z',
      ':outcome': 'applied',
      ':sha': 'abc123',
    });
  });

  it('omits commitSha/error when not provided (failed with no commit)', async () => {
    sendMock.mockResolvedValue({ Attributes: { id: 'r', applyOutcome: 'failed' } });
    await markReflectionApplied({ projectSlug: 'p', id: 'r', outcome: 'failed', error: 'gate1' });
    const cmd = input(sendMock.mock.calls[0][0]);
    expect(cmd.UpdateExpression).not.toContain('appliedCommitSha');
    expect(cmd.UpdateExpression).toContain('applyError = :err');
  });

  it('on a racing ConditionalCheckFailed, falls back to the already-stamped row', async () => {
    sendMock
      .mockRejectedValueOnce({ name: 'ConditionalCheckFailedException' })
      .mockResolvedValueOnce({ Item: { id: 'r', appliedAt: 'earlier', applyOutcome: 'applied' } });
    const out = await markReflectionApplied({ projectSlug: 'p', id: 'r', outcome: 'applied' });
    expect(out?.appliedAt).toBe('earlier');
    // second call is the getReflection fallback (a GetCommand)
    expect(input(sendMock.mock.calls[1][0]).Key).toEqual({ projectSlug: 'p', id: 'r' });
  });
});
