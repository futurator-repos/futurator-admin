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
  createBrownfieldProjectRow,
  tryAcquireRefreshLock,
  releaseRefreshLock,
  updateProjectAfterRefresh,
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
    sendMock.mockResolvedValue({
      Item: { projectId: 'x', kind: 'greenfield', bmadStatus: 'HEALTHY' },
    });
    const result = await getProject('x');
    expect(result).toEqual({ projectId: 'x', kind: 'greenfield', bmadStatus: 'HEALTHY' });
  });

  it('lazy-migrates legacy rows missing kind to greenfield (Story 15.4 AC #1)', async () => {
    sendMock.mockResolvedValue({ Item: { projectId: 'legacy', bmadStatus: 'HEALTHY' } });
    const result = await getProject('legacy');
    expect(result).toEqual({ projectId: 'legacy', bmadStatus: 'HEALTHY', kind: 'greenfield' });
  });

  it('preserves kind=brownfield on read without overriding it', async () => {
    sendMock.mockResolvedValue({
      Item: {
        projectId: 'songster',
        kind: 'brownfield',
        bmadStatus: 'HEALTHY',
        gitRepoUrl: 'https://github.com/x/songster',
      },
    });
    const result = await getProject('songster');
    expect(result?.kind).toBe('brownfield');
    expect(result?.gitRepoUrl).toBe('https://github.com/x/songster');
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

  it('lazy-migrates each legacy row missing kind (Story 15.4 AC #1)', async () => {
    sendMock.mockResolvedValueOnce({
      Items: [{ projectId: 'a' }, { projectId: 'b', kind: 'brownfield' }, { projectId: 'c' }],
    });
    const result = await listProjects();
    expect(result.map((p) => [p.projectId, p.kind])).toEqual([
      ['a', 'greenfield'],
      ['b', 'brownfield'],
      ['c', 'greenfield'],
    ]);
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

describe('createBrownfieldProjectRow', () => {
  it('PUTs a brownfield row with kind, git fields, and conditional create (Story 15.4 AC #2)', async () => {
    sendMock.mockResolvedValue({});
    const ok = await createBrownfieldProjectRow('songster', '/home/ubuntu/projects/songster', {
      gitRepoUrl: 'https://github.com/foo/songster.git',
      gitBranch: 'main',
    });
    expect(ok).toBe(true);
    const input = extract(sendMock.mock.calls[0][0]);
    expect(input.ConditionExpression).toContain('attribute_not_exists');
    const item = input.Item as Record<string, unknown>;
    expect(item.kind).toBe('brownfield');
    expect(item.gitRepoUrl).toBe('https://github.com/foo/songster.git');
    expect(item.gitBranch).toBe('main');
    expect(item.lastPulledAt).toBeNull();
    expect(item.lastCommitSha).toBeNull();
  });

  it('returns false when the row already exists', async () => {
    const err = new Error('conditional failed') as Error & { name: string };
    err.name = 'ConditionalCheckFailedException';
    sendMock.mockRejectedValue(err);
    const ok = await createBrownfieldProjectRow('songster', '/home/ubuntu/projects/songster', {
      gitRepoUrl: 'https://github.com/foo/songster.git',
      gitBranch: 'main',
    });
    expect(ok).toBe(false);
  });

  it('propagates non-ConditionalCheckFailedException errors', async () => {
    sendMock.mockRejectedValue(new Error('boom'));
    await expect(
      createBrownfieldProjectRow('songster', '/home/ubuntu/projects/songster', {
        gitRepoUrl: 'https://github.com/foo/songster.git',
        gitBranch: 'main',
      }),
    ).rejects.toThrow('boom');
  });
});

describe('tryAcquireRefreshLock', () => {
  it('transitions HEALTHY → REFRESHING on success (Story 15.4 AC #7)', async () => {
    sendMock.mockResolvedValue({});
    const result = await tryAcquireRefreshLock('songster');
    expect(result).toEqual({ ok: true });
    const input = extract(sendMock.mock.calls[0][0]);
    expect(input.ConditionExpression).toContain('bmadStatus IN');
    const values = input.ExpressionAttributeValues as Record<string, unknown>;
    expect(values[':refreshing']).toBe('REFRESHING');
    expect(values[':healthy']).toBe('HEALTHY');
    expect(values[':drifted']).toBe('DRIFTED');
  });

  it('returns REFRESH_IN_PROGRESS when current state is REFRESHING', async () => {
    const err = new Error('conditional failed') as Error & { name: string };
    err.name = 'ConditionalCheckFailedException';
    sendMock
      .mockRejectedValueOnce(err)
      .mockResolvedValueOnce({ Item: { projectId: 'songster', bmadStatus: 'REFRESHING' } });
    const result = await tryAcquireRefreshLock('songster');
    expect(result).toEqual({ ok: false, reason: 'REFRESH_IN_PROGRESS' });
  });

  it('returns NOT_FOUND when row is missing', async () => {
    const err = new Error('conditional failed') as Error & { name: string };
    err.name = 'ConditionalCheckFailedException';
    sendMock.mockRejectedValueOnce(err).mockResolvedValueOnce({});
    const result = await tryAcquireRefreshLock('ghost');
    expect(result).toEqual({ ok: false, reason: 'NOT_FOUND' });
  });

  it('returns INVALID_STATE for non-healthy/refreshing states', async () => {
    const err = new Error('conditional failed') as Error & { name: string };
    err.name = 'ConditionalCheckFailedException';
    sendMock
      .mockRejectedValueOnce(err)
      .mockResolvedValueOnce({ Item: { projectId: 'songster', bmadStatus: 'INSTALLING' } });
    const result = await tryAcquireRefreshLock('songster');
    expect(result).toEqual({ ok: false, reason: 'INVALID_STATE' });
  });
});

describe('releaseRefreshLock', () => {
  it('sets bmadStatus to HEALTHY', async () => {
    sendMock.mockResolvedValue({});
    await releaseRefreshLock('songster', 'HEALTHY');
    const input = extract(sendMock.mock.calls[0][0]);
    expect((input.ExpressionAttributeValues as Record<string, unknown>)[':next']).toBe('HEALTHY');
  });

  it('sets bmadStatus to FAILED', async () => {
    sendMock.mockResolvedValue({});
    await releaseRefreshLock('songster', 'FAILED');
    const input = extract(sendMock.mock.calls[0][0]);
    expect((input.ExpressionAttributeValues as Record<string, unknown>)[':next']).toBe('FAILED');
  });
});

describe('updateProjectAfterRefresh', () => {
  it('writes lastPulledAt, lastCommitSha, customAgentsSHA via UpdateCommand', async () => {
    sendMock.mockResolvedValue({});
    await updateProjectAfterRefresh('songster', {
      lastPulledAt: '2026-05-17T12:00:00.000Z',
      lastCommitSha: 'abc1234567',
      customAgentsSHA: 'sha256-abc',
    });
    const input = extract(sendMock.mock.calls[0][0]);
    const values = input.ExpressionAttributeValues as Record<string, unknown>;
    expect(values[':lastPulledAt']).toBe('2026-05-17T12:00:00.000Z');
    expect(values[':lastCommitSha']).toBe('abc1234567');
    expect(values[':customAgentsSHA']).toBe('sha256-abc');
    expect(values[':lastInspectedAt']).toBe('2026-05-17T12:00:00.000Z');
  });
});
