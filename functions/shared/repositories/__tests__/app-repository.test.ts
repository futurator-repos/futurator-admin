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
    plans: 'test-plans',
    apps: 'test-apps',
  },
}));

import {
  createApp,
  getApp,
  listApps,
  updateApp,
  appendDeployJobId,
  deleteApp,
} from '../app-repository';
import type { App } from '../../types/app';

function extractInput(command: unknown): Record<string, unknown> {
  return (command as { input: Record<string, unknown> }).input;
}

function baseApp(overrides: Partial<App> = {}): App {
  return {
    appId: 'dino3',
    displayName: 'Dino Runner v3',
    icon: '🦖',
    workingDir: '/home/ubuntu/projects/dino3',
    executionMode: 'orchestrator',
    currentlyDeployedPlanId: null,
    deployJobIds: [],
    workingTreeStatus: 'clean',
    createdAt: '2026-04-27T00:00:00.000Z',
    updatedAt: '2026-04-27T00:00:00.000Z',
    ...overrides,
  };
}

beforeEach(() => {
  sendMock.mockReset();
});

describe('createApp', () => {
  it('creates a new App with derived workingDir + clean tree state', async () => {
    sendMock
      .mockResolvedValueOnce({ Item: undefined }) // GetCommand for existence check
      .mockResolvedValueOnce({}); // PutCommand

    const created = await createApp({
      appId: 'dino3',
      displayName: 'Dino Runner v3',
      icon: '🦖',
    });

    expect(created.appId).toBe('dino3');
    expect(created.workingDir).toBe('/home/ubuntu/projects/dino3');
    expect(created.workingTreeStatus).toBe('clean');
    expect(created.currentlyDeployedPlanId).toBe(null);
    expect(created.deployJobIds).toEqual([]);
    expect(created.executionMode).toBe('orchestrator'); // default
    expect(sendMock).toHaveBeenCalledTimes(2);
  });

  it('uses provided executionMode override', async () => {
    sendMock.mockResolvedValueOnce({ Item: undefined }).mockResolvedValueOnce({});

    const created = await createApp({
      appId: 'dino3',
      displayName: 'Dino Runner v3',
      executionMode: 'pipeline',
    });

    expect(created.executionMode).toBe('pipeline');
  });

  it('rejects invalid slug format', async () => {
    await expect(createApp({ appId: 'BadSlug', displayName: 'X' })).rejects.toMatchObject({
      code: 'APP_ID_INVALID',
      statusCode: 400,
    });
    await expect(createApp({ appId: '-leading-hyphen', displayName: 'X' })).rejects.toMatchObject({
      code: 'APP_ID_INVALID',
    });
  });

  it('rejects reserved slug', async () => {
    await expect(createApp({ appId: 'apps', displayName: 'X' })).rejects.toMatchObject({
      code: 'APP_ID_RESERVED',
      statusCode: 400,
    });
    await expect(createApp({ appId: 'media', displayName: 'X' })).rejects.toMatchObject({
      code: 'APP_ID_RESERVED',
    });
  });

  it('rejects duplicate appId', async () => {
    sendMock.mockResolvedValueOnce({ Item: baseApp() });

    await expect(createApp({ appId: 'dino3', displayName: 'X' })).rejects.toMatchObject({
      code: 'APP_ID_TAKEN',
      statusCode: 409,
    });
  });
});

describe('getApp', () => {
  it('returns the App when present', async () => {
    sendMock.mockResolvedValueOnce({ Item: baseApp() });
    const app = await getApp('dino3');
    expect(app?.appId).toBe('dino3');
  });

  it('returns null when missing', async () => {
    sendMock.mockResolvedValueOnce({ Item: undefined });
    const app = await getApp('missing');
    expect(app).toBe(null);
  });
});

describe('listApps', () => {
  it('returns all Apps from the scan', async () => {
    sendMock.mockResolvedValueOnce({
      Items: [baseApp(), baseApp({ appId: 'brick-breaker' })],
    });
    const apps = await listApps();
    expect(apps).toHaveLength(2);
    expect(apps.map((a) => a.appId)).toEqual(['dino3', 'brick-breaker']);
  });

  it('returns [] when scan has no items', async () => {
    sendMock.mockResolvedValueOnce({ Items: undefined });
    const apps = await listApps();
    expect(apps).toEqual([]);
  });
});

describe('updateApp', () => {
  it('returns existing App when patch is empty', async () => {
    sendMock.mockResolvedValueOnce({ Item: baseApp() });
    const result = await updateApp('dino3', {});
    expect(result.appId).toBe('dino3');
  });

  it('returns the updated App for non-empty patch', async () => {
    sendMock.mockResolvedValueOnce({
      Attributes: baseApp({ displayName: 'New Name' }),
    });

    const result = await updateApp('dino3', { displayName: 'New Name' });
    expect(result.displayName).toBe('New Name');
    expect(sendMock).toHaveBeenCalledTimes(1);
  });

  it('throws APP_NOT_FOUND on conditional check failure', async () => {
    const err: Error = Object.assign(new Error('not found'), {
      name: 'ConditionalCheckFailedException',
    });
    sendMock.mockRejectedValueOnce(err);

    await expect(updateApp('missing', { displayName: 'New' })).rejects.toMatchObject({
      code: 'APP_NOT_FOUND',
      statusCode: 404,
    });
  });
});

describe('appendDeployJobId', () => {
  it('returns the App with the new deploy job appended', async () => {
    sendMock.mockResolvedValueOnce({
      Attributes: baseApp({ deployJobIds: ['d1', 'd2'] }),
    });

    const result = await appendDeployJobId('dino3', 'd2');
    expect(result.deployJobIds).toEqual(['d1', 'd2']);
    expect(sendMock).toHaveBeenCalledTimes(1);
  });

  it('throws APP_NOT_FOUND when the App does not exist', async () => {
    const err: Error = Object.assign(new Error('not found'), {
      name: 'ConditionalCheckFailedException',
    });
    sendMock.mockRejectedValueOnce(err);

    await expect(appendDeployJobId('missing', 'd1')).rejects.toMatchObject({
      code: 'APP_NOT_FOUND',
      statusCode: 404,
    });
  });
});

describe('deleteApp', () => {
  it('calls send once with a DeleteCommand', async () => {
    sendMock.mockResolvedValueOnce({});
    await deleteApp('dino3');
    expect(sendMock).toHaveBeenCalledTimes(1);
  });
});
