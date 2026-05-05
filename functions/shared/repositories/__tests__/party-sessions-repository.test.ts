import { describe, it, expect, vi, beforeEach } from 'vitest';

const { sendMock } = vi.hoisted(() => ({ sendMock: vi.fn() }));

vi.mock('../../dynamo-client', () => ({
  docClient: { send: sendMock },
  TABLE_NAMES: {
    agentJobs: 'test-agent-jobs',
    projects: 'test-projects',
    costs: 'test-costs',
    resources: 'test-resources',
    audits: 'test-audits',
    schedules: 'test-schedules',
    users: 'test-users',
    alerts: 'test-alerts',
    agentEvents: 'test-agent-events',
    epicWorkflows: 'test-epic-workflows',
    projectRegistry: 'test-project-registry',
    partyProjects: 'test-party-projects',
    partySessions: 'test-party-sessions',
  },
}));

import {
  getSession,
  listSessionsByProject,
  createSession,
  tryAcquireSessionLock,
  releaseSessionLock,
  incrementTurn,
  setClaudeSessionId,
} from '../party-sessions-repository';

function extract(command: unknown) {
  return (command as { input: Record<string, unknown> }).input;
}

beforeEach(() => {
  sendMock.mockReset();
});

describe('getSession', () => {
  it('returns null when the row is absent', async () => {
    sendMock.mockResolvedValue({});
    expect(await getSession('sid')).toBeNull();
  });

  it('returns the row when present', async () => {
    sendMock.mockResolvedValue({ Item: { sessionId: 'sid', status: 'ACTIVE' } });
    expect(await getSession('sid')).toEqual({ sessionId: 'sid', status: 'ACTIVE' });
  });
});

describe('listSessionsByProject', () => {
  it('queries GSI1 with newest-first ordering', async () => {
    sendMock.mockResolvedValue({ Items: [{ sessionId: 'a' }, { sessionId: 'b' }] });
    const result = await listSessionsByProject('battleship');
    expect(result).toHaveLength(2);
    const input = extract(sendMock.mock.calls[0][0]);
    expect(input.IndexName).toBe('GSI1');
    expect(input.KeyConditionExpression).toBe('GSI1PK = :pk');
    expect(input.ExpressionAttributeValues).toEqual({ ':pk': 'battleship' });
    expect(input.ScanIndexForward).toBe(false);
  });
});

describe('createSession', () => {
  it('PUTs a row with ACTIVE status and GSI1 keys', async () => {
    sendMock.mockResolvedValue({});
    const row = await createSession({
      projectId: 'battleship',
      projectPath: '/home/ubuntu/projects/battleship',
      bmadVersionAtStart: '6.0.0-alpha.7',
    });
    expect(row.sessionId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    );
    expect(row.status).toBe('ACTIVE');
    expect(row.turnCount).toBe(0);
    expect(row.claudeSessionId).toBeNull();
    expect(row.GSI1PK).toBe('battleship');
    expect(row.GSI1SK).toBe(row.createdAt);

    const input = extract(sendMock.mock.calls[0][0]);
    expect(input.TableName).toBe('test-party-sessions');
  });

  it('carries the optional topic through', async () => {
    sendMock.mockResolvedValue({});
    const row = await createSession({
      projectId: 'battleship',
      projectPath: '/home/ubuntu/projects/battleship',
      topic: 'Talk about UI',
      bmadVersionAtStart: '6.0.0-alpha.7',
    });
    expect(row.topic).toBe('Talk about UI');
  });
});

describe('tryAcquireSessionLock', () => {
  it('returns ok when conditional update succeeds', async () => {
    sendMock.mockResolvedValue({});
    expect(await tryAcquireSessionLock('sid')).toEqual({ ok: true });
    const input = extract(sendMock.mock.calls[0][0]);
    expect(input.ConditionExpression).toContain('#status = :active OR #status = :idle');
    expect((input.ExpressionAttributeValues as Record<string, unknown>)[':processing']).toBe(
      'PROCESSING',
    );
  });

  it('returns SESSION_BUSY when the row already has status PROCESSING', async () => {
    const err = new Error('conditional failed') as Error & { name: string };
    err.name = 'ConditionalCheckFailedException';
    sendMock
      .mockRejectedValueOnce(err)
      .mockResolvedValueOnce({ Item: { sessionId: 'sid', status: 'PROCESSING' } });
    expect(await tryAcquireSessionLock('sid')).toEqual({ ok: false, reason: 'SESSION_BUSY' });
  });

  it('returns NOT_ACTIVE when status is ERROR / ARCHIVED', async () => {
    const err = new Error('conditional failed') as Error & { name: string };
    err.name = 'ConditionalCheckFailedException';
    sendMock
      .mockRejectedValueOnce(err)
      .mockResolvedValueOnce({ Item: { sessionId: 'sid', status: 'ERROR' } });
    expect(await tryAcquireSessionLock('sid')).toEqual({ ok: false, reason: 'NOT_ACTIVE' });
  });

  it('returns NOT_FOUND when the row is missing', async () => {
    const err = new Error('conditional failed') as Error & { name: string };
    err.name = 'ConditionalCheckFailedException';
    sendMock.mockRejectedValueOnce(err).mockResolvedValueOnce({});
    expect(await tryAcquireSessionLock('sid')).toEqual({ ok: false, reason: 'NOT_FOUND' });
  });

  it('rethrows unexpected errors', async () => {
    sendMock.mockRejectedValue(new Error('boom'));
    await expect(tryAcquireSessionLock('sid')).rejects.toThrow('boom');
  });
});

describe('releaseSessionLock', () => {
  it('SETs #status to the given final status', async () => {
    sendMock.mockResolvedValue({});
    await releaseSessionLock('sid', 'ACTIVE');
    const input = extract(sendMock.mock.calls[0][0]);
    expect(input.UpdateExpression).toContain('SET #status = :s');
    expect((input.ExpressionAttributeValues as Record<string, unknown>)[':s']).toBe('ACTIVE');
  });
});

describe('incrementTurn', () => {
  it('ADDs 1 to turnCount and sets lastTurnAt', async () => {
    sendMock.mockResolvedValue({});
    await incrementTurn('sid');
    const input = extract(sendMock.mock.calls[0][0]);
    expect(input.UpdateExpression).toContain('ADD turnCount :one');
    expect((input.ExpressionAttributeValues as Record<string, unknown>)[':one']).toBe(1);
  });
});

describe('setClaudeSessionId', () => {
  it('SETs claudeSessionId with attribute_not_exists guard (only first time)', async () => {
    sendMock.mockResolvedValue({});
    await setClaudeSessionId('sid', 'claude-abc');
    const input = extract(sendMock.mock.calls[0][0]);
    expect(input.ConditionExpression).toContain('attribute_not_exists(claudeSessionId)');
    expect((input.ExpressionAttributeValues as Record<string, unknown>)[':cid']).toBe('claude-abc');
  });
});
