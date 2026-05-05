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
  getProject,
  listProjects,
  upsertProjectFromFilesystem,
  updateProjectState,
  tryAcquireBootstrapLock,
} from '../party-projects-repository';

function extract(command: unknown) {
  return (command as { input: Record<string, unknown> }).input;
}

beforeEach(() => {
  sendMock.mockReset();
});

describe('getProject', () => {
  it('returns null when item is absent', async () => {
    sendMock.mockResolvedValue({});
    const result = await getProject('battleship');
    expect(result).toBeNull();
    const input = extract(sendMock.mock.calls[0][0]);
    expect(input.TableName).toBe('test-party-projects');
    expect(input.Key).toEqual({ projectId: 'battleship' });
  });

  it('returns the item when present', async () => {
    sendMock.mockResolvedValue({ Item: { projectId: 'x', bmadStatus: 'HEALTHY' } });
    const result = await getProject('x');
    expect(result).toEqual({ projectId: 'x', bmadStatus: 'HEALTHY' });
  });
});

describe('listProjects', () => {
  it('scans the party-projects table', async () => {
    sendMock.mockResolvedValueOnce({ Items: [{ projectId: 'a' }, { projectId: 'b' }] });
    const result = await listProjects();
    expect(result).toHaveLength(2);
    const input = extract(sendMock.mock.calls[0][0]);
    expect(input.TableName).toBe('test-party-projects');
  });

  it('paginates via LastEvaluatedKey', async () => {
    sendMock
      .mockResolvedValueOnce({
        Items: [{ projectId: 'a' }],
        LastEvaluatedKey: { projectId: 'a' },
      })
      .mockResolvedValueOnce({ Items: [{ projectId: 'b' }] });
    const result = await listProjects();
    expect(result).toHaveLength(2);
    expect(sendMock).toHaveBeenCalledTimes(2);
  });
});

describe('upsertProjectFromFilesystem', () => {
  it('PUTs a new MISSING row with attribute_not_exists condition', async () => {
    sendMock.mockResolvedValue({});
    await upsertProjectFromFilesystem('battleship', '/home/ubuntu/projects/battleship');
    const input = extract(sendMock.mock.calls[0][0]);
    expect(input.ConditionExpression).toContain('attribute_not_exists');
    expect((input.Item as Record<string, unknown>).projectId).toBe('battleship');
    expect((input.Item as Record<string, unknown>).bmadStatus).toBe('MISSING');
  });

  it('silently no-ops when row already exists', async () => {
    const err = new Error('conditional failed') as Error & { name: string };
    err.name = 'ConditionalCheckFailedException';
    sendMock.mockRejectedValue(err);
    await expect(
      upsertProjectFromFilesystem('battleship', '/home/ubuntu/projects/battleship'),
    ).resolves.toBeUndefined();
  });

  it('propagates non-ConditionalCheckFailedException errors', async () => {
    sendMock.mockRejectedValue(new Error('boom'));
    await expect(
      upsertProjectFromFilesystem('battleship', '/home/ubuntu/projects/battleship'),
    ).rejects.toThrow('boom');
  });
});

describe('updateProjectState', () => {
  it('builds an UpdateCommand with dynamic fields', async () => {
    sendMock.mockResolvedValue({});
    await updateProjectState('battleship', { bmadStatus: 'HEALTHY', agentCount: 23 });
    const input = extract(sendMock.mock.calls[0][0]);
    expect(input.TableName).toBe('test-party-projects');
    expect(input.Key).toEqual({ projectId: 'battleship' });
    expect(input.UpdateExpression).toContain('#bmadStatus = :bmadStatus');
    expect(input.UpdateExpression).toContain('#agentCount = :agentCount');
    expect(input.UpdateExpression).toContain('#updatedAt = :updatedAt');
  });

  it('is a no-op when patch is empty', async () => {
    await updateProjectState('battleship', {});
    expect(sendMock).not.toHaveBeenCalled();
  });
});

describe('tryAcquireBootstrapLock', () => {
  it('returns ok on successful conditional transition', async () => {
    sendMock.mockResolvedValue({});
    const result = await tryAcquireBootstrapLock('battleship', 'job-123');
    expect(result).toEqual({ ok: true });
    const input = extract(sendMock.mock.calls[0][0]);
    expect(input.ConditionExpression).toContain('bmadStatus IN');
    expect((input.ExpressionAttributeValues as Record<string, unknown>)[':installing']).toBe(
      'INSTALLING',
    );
  });

  it('returns BOOTSTRAP_IN_PROGRESS when the conditional fails and row exists', async () => {
    const err = new Error('conditional failed') as Error & { name: string };
    err.name = 'ConditionalCheckFailedException';
    sendMock
      .mockRejectedValueOnce(err)
      .mockResolvedValueOnce({ Item: { projectId: 'battleship', bmadStatus: 'INSTALLING' } });
    const result = await tryAcquireBootstrapLock('battleship', 'job-123');
    expect(result).toEqual({ ok: false, reason: 'BOOTSTRAP_IN_PROGRESS' });
  });

  it('returns NOT_FOUND when the row is missing', async () => {
    const err = new Error('conditional failed') as Error & { name: string };
    err.name = 'ConditionalCheckFailedException';
    sendMock.mockRejectedValueOnce(err).mockResolvedValueOnce({});
    const result = await tryAcquireBootstrapLock('battleship', 'job-123');
    expect(result).toEqual({ ok: false, reason: 'NOT_FOUND' });
  });

  it('rethrows unexpected errors', async () => {
    sendMock.mockRejectedValue(new Error('boom'));
    await expect(tryAcquireBootstrapLock('x', 'j')).rejects.toThrow('boom');
  });
});
