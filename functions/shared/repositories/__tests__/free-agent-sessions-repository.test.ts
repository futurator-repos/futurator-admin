import { describe, it, expect, vi, beforeEach } from 'vitest';

const { sendMock } = vi.hoisted(() => ({ sendMock: vi.fn() }));

vi.mock('../../dynamo-client', () => ({
  docClient: { send: sendMock },
  TABLE_NAMES: {
    freeAgentSessions: 'test-free-agent-sessions',
  },
}));

import {
  createSession,
  getSession,
  acquireProcessingLock,
  releaseProcessingLock,
  setClaudeSessionId,
  markIdle,
  markExpired,
  markBudgetExhausted,
  markError,
  incrementTurn,
  updateCostUsd,
  updateTokens,
  setLastRefreshedAt,
  listAllSessions,
  listSessionsByOperator,
  listSessionsByScope,
  findBySessionIdShort,
} from '../free-agent-sessions-repository';

function extract(command: unknown) {
  return (command as { input: Record<string, unknown> }).input;
}

beforeEach(() => {
  sendMock.mockReset();
});

// ─── Reads ──────────────────────────────────────────────────────────

describe('getSession', () => {
  it('returns null when row is absent', async () => {
    sendMock.mockResolvedValue({});
    expect(await getSession('sid-1')).toBeNull();
  });

  it('returns the row when present', async () => {
    sendMock.mockResolvedValue({
      Item: { sessionId: 'sid-1', status: 'ACTIVE', model: 'sonnet' },
    });
    const row = await getSession('sid-1');
    expect(row?.sessionId).toBe('sid-1');
  });
});

describe('listAllSessions', () => {
  it('scans the full table and concatenates pages', async () => {
    sendMock
      .mockResolvedValueOnce({ Items: [{ sessionId: 'a' }], LastEvaluatedKey: { k: 1 } })
      .mockResolvedValueOnce({ Items: [{ sessionId: 'b' }], LastEvaluatedKey: undefined });

    const all = await listAllSessions();
    expect(all).toHaveLength(2);
    expect(all.map((s) => s.sessionId)).toEqual(['a', 'b']);
    expect(sendMock).toHaveBeenCalledTimes(2);
  });
});

describe('listSessionsByOperator', () => {
  it('queries GSI1 with operatorId, newest first, with limit', async () => {
    sendMock.mockResolvedValue({ Items: [{ sessionId: 's1' }] });
    await listSessionsByOperator('op-rick', 7);
    const input = extract(sendMock.mock.calls[0][0]);
    expect(input.IndexName).toBe('operator-recent-index');
    expect(input.KeyConditionExpression).toBe('operatorId = :op');
    expect(input.ExpressionAttributeValues).toEqual({ ':op': 'op-rick' });
    expect(input.ScanIndexForward).toBe(false);
    expect(input.Limit).toBe(7);
  });

  it('defaults limit to 20', async () => {
    sendMock.mockResolvedValue({ Items: [] });
    await listSessionsByOperator('op-rick');
    expect(extract(sendMock.mock.calls[0][0]).Limit).toBe(20);
  });
});

describe('listSessionsByScope', () => {
  it('queries GSI2 with scope composite key', async () => {
    sendMock.mockResolvedValue({ Items: [] });
    await listSessionsByScope({ kind: 'plan', id: 'dino-7' });
    const input = extract(sendMock.mock.calls[0][0]);
    expect(input.IndexName).toBe('scope-recent-index');
    expect(input.ExpressionAttributeValues).toEqual({ ':s': 'plan#dino-7' });
  });

  it('uses _ placeholder when scope.id is absent', async () => {
    sendMock.mockResolvedValue({ Items: [] });
    await listSessionsByScope({ kind: 'workspace' });
    expect(extract(sendMock.mock.calls[0][0]).ExpressionAttributeValues).toEqual({
      ':s': 'workspace#_',
    });
  });
});

// ─── Writes ─────────────────────────────────────────────────────────

describe('createSession', () => {
  it('PUTs an ACTIVE row with derived fields and 90d TTL', async () => {
    sendMock.mockResolvedValue({});
    const session = await createSession({
      sessionId: 'sid-1',
      operatorId: 'op-rick',
      projectId: 'dino-7',
      scope: { kind: 'plan', id: 'plan-abc' },
      model: 'sonnet',
      costCapUsd: 10,
    });

    expect(session.status).toBe('ACTIVE');
    expect(session.turnCount).toBe(0);
    expect(session.costUsdAccumulated).toBe(0);
    expect(session.scopeIdComposite).toBe('plan#plan-abc');
    // 90d TTL in epoch seconds
    const expectedTtl = Math.floor(Date.now() / 1000) + 90 * 24 * 60 * 60;
    expect(session.expiresAt).toBeGreaterThan(expectedTtl - 5);
    expect(session.expiresAt).toBeLessThan(expectedTtl + 5);

    const input = extract(sendMock.mock.calls[0][0]);
    expect(input.ConditionExpression).toBe('attribute_not_exists(sessionId)');
    expect(input.Item).toMatchObject({
      sessionId: 'sid-1',
      operatorId: 'op-rick',
      projectId: 'dino-7',
      status: 'ACTIVE',
    });
  });
});

describe('acquireProcessingLock (AC #7)', () => {
  it('returns ok:true when conditional update succeeds (ACTIVE → PROCESSING)', async () => {
    sendMock.mockResolvedValue({});
    const result = await acquireProcessingLock('sid-1');
    expect(result).toEqual({ ok: true });

    const input = extract(sendMock.mock.calls[0][0]);
    expect(input.ConditionExpression).toBe('attribute_exists(sessionId) AND #status = :active');
    expect(input.ExpressionAttributeValues).toMatchObject({
      ':processing': 'PROCESSING',
      ':active': 'ACTIVE',
    });
  });

  it('returns SESSION_BUSY when row is in PROCESSING state', async () => {
    const conditionalErr = Object.assign(new Error('ConditionalCheckFailed'), {
      name: 'ConditionalCheckFailedException',
    });
    sendMock
      .mockRejectedValueOnce(conditionalErr)
      .mockResolvedValueOnce({ Item: { sessionId: 'sid-1', status: 'PROCESSING' } });

    const result = await acquireProcessingLock('sid-1');
    expect(result).toEqual({ ok: false, reason: 'SESSION_BUSY' });
  });

  it('returns NOT_FOUND when row does not exist', async () => {
    const conditionalErr = Object.assign(new Error('ConditionalCheckFailed'), {
      name: 'ConditionalCheckFailedException',
    });
    sendMock.mockRejectedValueOnce(conditionalErr).mockResolvedValueOnce({}); // no Item
    expect(await acquireProcessingLock('sid-1')).toEqual({ ok: false, reason: 'NOT_FOUND' });
  });

  it('returns INVALID_STATE for IDLE/EXPIRED/ERROR/BUDGET_EXHAUSTED', async () => {
    const conditionalErr = Object.assign(new Error('ConditionalCheckFailed'), {
      name: 'ConditionalCheckFailedException',
    });
    sendMock
      .mockRejectedValueOnce(conditionalErr)
      .mockResolvedValueOnce({ Item: { sessionId: 'sid-1', status: 'EXPIRED' } });

    expect(await acquireProcessingLock('sid-1')).toEqual({ ok: false, reason: 'INVALID_STATE' });
  });

  it('re-throws unrelated errors', async () => {
    sendMock.mockRejectedValue(new Error('throughput exceeded'));
    await expect(acquireProcessingLock('sid-1')).rejects.toThrow(/throughput/);
  });
});

describe('releaseProcessingLock', () => {
  it('sets status to ACTIVE on normal completion', async () => {
    sendMock.mockResolvedValue({});
    await releaseProcessingLock('sid-1', 'ACTIVE');
    const input = extract(sendMock.mock.calls[0][0]);
    expect(input.ExpressionAttributeValues).toMatchObject({ ':s': 'ACTIVE' });
  });

  it('sets status to ERROR on failure', async () => {
    sendMock.mockResolvedValue({});
    await releaseProcessingLock('sid-1', 'ERROR');
    expect(extract(sendMock.mock.calls[0][0]).ExpressionAttributeValues).toMatchObject({
      ':s': 'ERROR',
    });
  });
});

describe('setClaudeSessionId', () => {
  it('sets claudeSessionId with idempotent condition', async () => {
    sendMock.mockResolvedValue({});
    await setClaudeSessionId('sid-1', 'claude-xyz');
    const input = extract(sendMock.mock.calls[0][0]);
    expect(input.UpdateExpression).toContain('claudeSessionId');
    expect(input.ConditionExpression).toContain('attribute_not_exists(claudeSessionId)');
    expect(input.ConditionExpression).toContain('claudeSessionId = :cid');
  });
});

describe('mark* transitions (AC #4 + #5)', () => {
  it('markIdle requires status=ACTIVE', async () => {
    sendMock.mockResolvedValue({});
    await markIdle('sid-1');
    const input = extract(sendMock.mock.calls[0][0]);
    expect(input.ExpressionAttributeValues).toMatchObject({ ':s': 'IDLE', ':p0': 'ACTIVE' });
    expect(input.ConditionExpression).toContain('#status IN');
  });

  it('markExpired requires status=IDLE', async () => {
    sendMock.mockResolvedValue({});
    await markExpired('sid-1');
    const input = extract(sendMock.mock.calls[0][0]);
    expect(input.ExpressionAttributeValues).toMatchObject({ ':s': 'EXPIRED', ':p0': 'IDLE' });
  });

  it('markBudgetExhausted accepts PROCESSING or ACTIVE source states', async () => {
    sendMock.mockResolvedValue({});
    await markBudgetExhausted('sid-1');
    const input = extract(sendMock.mock.calls[0][0]);
    expect(input.ExpressionAttributeValues).toMatchObject({
      ':s': 'BUDGET_EXHAUSTED',
      ':p0': 'PROCESSING',
      ':p1': 'ACTIVE',
    });
  });

  it('markError sets ERROR + errorReason from any prior state', async () => {
    sendMock.mockResolvedValue({});
    await markError('sid-1', 'TIMEOUT');
    const input = extract(sendMock.mock.calls[0][0]);
    expect(input.ExpressionAttributeValues).toMatchObject({
      ':s': 'ERROR',
      ':r': 'TIMEOUT',
    });
    expect(input.UpdateExpression).toContain('errorReason');
  });
});

describe('incrementTurn', () => {
  it('atomically bumps turnCount and updates lastTurnAt + lastActivityAt', async () => {
    sendMock.mockResolvedValue({});
    await incrementTurn('sid-1');
    const input = extract(sendMock.mock.calls[0][0]);
    expect(input.UpdateExpression).toContain('ADD turnCount :one');
    expect(input.UpdateExpression).toContain('lastTurnAt');
    expect(input.UpdateExpression).toContain('lastActivityAt');
    expect(input.ExpressionAttributeValues).toMatchObject({ ':one': 1 });
  });
});

describe('updateCostUsd', () => {
  it('adds positive delta via ADD expression', async () => {
    sendMock.mockResolvedValue({});
    await updateCostUsd('sid-1', 0.42);
    const input = extract(sendMock.mock.calls[0][0]);
    expect(input.UpdateExpression).toBe('ADD costUsdAccumulated :d');
    expect(input.ExpressionAttributeValues).toMatchObject({ ':d': 0.42 });
  });

  it('no-ops on zero/negative/non-finite delta', async () => {
    await updateCostUsd('sid-1', 0);
    await updateCostUsd('sid-1', -1);
    await updateCostUsd('sid-1', Number.NaN);
    expect(sendMock).not.toHaveBeenCalled();
  });
});

describe('updateTokens (Story 18.3 AC #3)', () => {
  it('issues ADD expression with both deltas', async () => {
    sendMock.mockResolvedValue({});
    await updateTokens('sid-1', 100, 50);
    const input = extract(sendMock.mock.calls[0][0]);
    expect(input.UpdateExpression).toBe('ADD tokensInAccumulated :i, tokensOutAccumulated :o');
    expect(input.ExpressionAttributeValues).toMatchObject({ ':i': 100, ':o': 50 });
    expect(input.ConditionExpression).toBe('attribute_exists(sessionId)');
  });

  it('no-ops when both deltas are zero', async () => {
    await updateTokens('sid-1', 0, 0);
    expect(sendMock).not.toHaveBeenCalled();
  });

  it('no-ops when both deltas are negative/non-finite', async () => {
    await updateTokens('sid-1', -10, -5);
    await updateTokens('sid-1', Number.NaN, Number.NaN);
    expect(sendMock).not.toHaveBeenCalled();
  });

  it('zero-clamps individual negative or non-finite deltas', async () => {
    sendMock.mockResolvedValue({});
    await updateTokens('sid-1', -5, 100);
    const input = extract(sendMock.mock.calls[0][0]);
    expect(input.ExpressionAttributeValues).toMatchObject({ ':i': 0, ':o': 100 });
  });
});

describe('setLastRefreshedAt', () => {
  it('writes provided timestamp', async () => {
    sendMock.mockResolvedValue({});
    await setLastRefreshedAt('sid-1', '2026-05-17T20:00:00.000Z');
    expect(extract(sendMock.mock.calls[0][0]).ExpressionAttributeValues).toMatchObject({
      ':t': '2026-05-17T20:00:00.000Z',
    });
  });

  it('defaults to now() when omitted', async () => {
    sendMock.mockResolvedValue({});
    await setLastRefreshedAt('sid-1');
    const value = (
      extract(sendMock.mock.calls[0][0]).ExpressionAttributeValues as Record<string, string>
    )[':t'];
    expect(Date.parse(value)).not.toBeNaN();
  });
});

// 2026-05-27 (unification) — short-form lookup used by the worktree reaper.
describe('findBySessionIdShort', () => {
  it('returns null for non-hex / wrong-length prefixes', async () => {
    expect(await findBySessionIdShort('not-hex!')).toBeNull();
    expect(await findBySessionIdShort('abc')).toBeNull();
    expect(await findBySessionIdShort('a1b2c3d4e5')).toBeNull();
    expect(await findBySessionIdShort('A1B2C3D4')).toBeNull();
    expect(sendMock).not.toHaveBeenCalled();
  });

  it('returns null when no rows match the prefix', async () => {
    sendMock.mockResolvedValueOnce({ Items: [], LastEvaluatedKey: undefined });
    expect(await findBySessionIdShort('a1b2c3d4')).toBeNull();
    const input = extract(sendMock.mock.calls[0][0]);
    expect(input.FilterExpression).toBe('begins_with(sessionId, :p)');
    expect(input.ExpressionAttributeValues).toEqual({ ':p': 'a1b2c3d4' });
    expect(input.Limit).toBeUndefined();
  });

  it('returns the first match across paginated scan pages', async () => {
    sendMock
      .mockResolvedValueOnce({ Items: [], LastEvaluatedKey: { k: 1 } })
      .mockResolvedValueOnce({
        Items: [{ sessionId: 'a1b2c3d4-...-uuid', status: 'ACTIVE' }],
        LastEvaluatedKey: undefined,
      });
    const row = await findBySessionIdShort('a1b2c3d4');
    expect(row?.sessionId).toBe('a1b2c3d4-...-uuid');
    expect(sendMock).toHaveBeenCalledTimes(2);
  });

  it('returns the first item and warns when multiple matches (collision)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    sendMock.mockResolvedValueOnce({
      Items: [
        { sessionId: 'a1b2c3d4-row-1' },
        { sessionId: 'a1b2c3d4-row-2' },
        { sessionId: 'a1b2c3d4-row-3' },
      ],
      LastEvaluatedKey: undefined,
    });
    const row = await findBySessionIdShort('a1b2c3d4');
    expect(row?.sessionId).toBe('a1b2c3d4-row-1');
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});
