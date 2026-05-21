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

import { findBySessionIdShort } from '../party-sessions-repository';

function extract(command: unknown) {
  return (command as { input: Record<string, unknown> }).input;
}

beforeEach(() => {
  sendMock.mockReset();
});

describe('findBySessionIdShort — Story 19.8', () => {
  it('returns the session when the 8-char prefix matches exactly one row', async () => {
    sendMock.mockResolvedValue({
      Items: [{ sessionId: 'a1b2c3d4-1111-2222-3333-444455556666', status: 'ACTIVE' }],
    });
    const session = await findBySessionIdShort('a1b2c3d4');
    expect(session?.sessionId).toBe('a1b2c3d4-1111-2222-3333-444455556666');
    const input = extract(sendMock.mock.calls[0][0]);
    expect(input.FilterExpression).toBe('begins_with(sessionId, :p)');
    expect(input.ExpressionAttributeValues).toEqual({ ':p': 'a1b2c3d4' });
    expect(input.Limit).toBe(5);
    expect(input.TableName).toBe('test-party-sessions');
  });

  it('returns null when the scan returns no items', async () => {
    sendMock.mockResolvedValue({ Items: [] });
    expect(await findBySessionIdShort('deadbeef')).toBeNull();
  });

  it('returns null when Items is undefined', async () => {
    sendMock.mockResolvedValue({});
    expect(await findBySessionIdShort('cafebabe')).toBeNull();
  });

  it('warn-logs and returns the first row when multiple matches come back', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    sendMock.mockResolvedValue({
      Items: [
        { sessionId: 'aaaaaaaa-0000-0000-0000-000000000001', status: 'ACTIVE' },
        { sessionId: 'aaaaaaaa-0000-0000-0000-000000000002', status: 'ENDED' },
      ],
    });
    const session = await findBySessionIdShort('aaaaaaaa');
    expect(session?.sessionId).toBe('aaaaaaaa-0000-0000-0000-000000000001');
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('2 matches'));
    warnSpy.mockRestore();
  });

  it('rejects uppercase input without invoking docClient', async () => {
    const result = await findBySessionIdShort('A1B2C3D4');
    expect(result).toBeNull();
    expect(sendMock).not.toHaveBeenCalled();
  });

  it('rejects wrong-length input without invoking docClient', async () => {
    expect(await findBySessionIdShort('a1b2c3d')).toBeNull(); // 7 chars
    expect(await findBySessionIdShort('a1b2c3d4e')).toBeNull(); // 9 chars
    expect(await findBySessionIdShort('a1b2c3d4-1111')).toBeNull(); // full-UUID-ish
    expect(sendMock).not.toHaveBeenCalled();
  });

  it('rejects non-hex characters without invoking docClient', async () => {
    expect(await findBySessionIdShort('zzzzzzzz')).toBeNull();
    expect(await findBySessionIdShort('a1b2c3g4')).toBeNull(); // g is non-hex
    expect(sendMock).not.toHaveBeenCalled();
  });

  it('rejects non-string input without invoking docClient', async () => {
    // @ts-expect-error — intentional invalid input
    expect(await findBySessionIdShort(undefined)).toBeNull();
    // @ts-expect-error — intentional invalid input
    expect(await findBySessionIdShort(12345678)).toBeNull();
    expect(sendMock).not.toHaveBeenCalled();
  });
});
