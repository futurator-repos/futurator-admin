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
  },
}));

import { appendWaveResult } from '../agent-jobs-repository';
import type { WaveResult } from '../../types/agent-orchestrator';

function extract(command: unknown) {
  return (command as { input: Record<string, unknown> }).input;
}

describe('appendWaveResult', () => {
  beforeEach(() => {
    sendMock.mockReset();
    sendMock.mockResolvedValue({});
  });

  it('issues two UpdateCommands: seed-if-missing then set nested wave key', async () => {
    const result: WaveResult = {
      waveNumber: 2,
      stories: {
        'S-1': {
          status: 'APPROVED',
          attempts: 1,
          reviewAttempts: 1,
          filesTouched: ['src/a.ts'],
        },
      },
      durationMs: 12_345,
      completedAt: 1_700_000_000,
    };

    await appendWaveResult('job-1', 2, result);

    expect(sendMock).toHaveBeenCalledTimes(2);
    const first = extract(sendMock.mock.calls[0][0]);
    expect(first.TableName).toBe('test-agent-jobs');
    expect(first.Key).toEqual({ jobId: 'job-1' });
    expect(first.UpdateExpression).toContain('if_not_exists(#wr, :empty)');
    expect(first.ExpressionAttributeNames).toEqual({ '#wr': 'waveResults' });

    const second = extract(sendMock.mock.calls[1][0]);
    expect(second.UpdateExpression).toContain('SET #wr.#w = :r');
    expect(second.UpdateExpression).toContain('#ua = :now');
    expect(second.UpdateExpression).toContain('#hb = :now');
    expect(second.ExpressionAttributeNames).toMatchObject({
      '#wr': 'waveResults',
      '#w': '2',
    });
    const r = (second.ExpressionAttributeValues as Record<string, WaveResult>)[':r'];
    expect(r.waveNumber).toBe(2);
    expect(r.stories['S-1'].status).toBe('APPROVED');
    expect(r.persistedAt).toBeDefined();
  });

  it('coerces numeric wave keys to strings for map path', async () => {
    const result: WaveResult = {
      waveNumber: 3,
      stories: {},
      durationMs: 1,
      completedAt: 1,
    };
    await appendWaveResult('job-2', 3, result);
    const second = extract(sendMock.mock.calls[1][0]);
    expect((second.ExpressionAttributeNames as Record<string, string>)['#w']).toBe('3');
  });

  it('preserves caller-provided persistedAt', async () => {
    const iso = '2026-04-17T00:00:00.000Z';
    const result: WaveResult = {
      waveNumber: 1,
      stories: {},
      durationMs: 1,
      completedAt: 1,
      persistedAt: iso,
    };
    await appendWaveResult('job-3', 1, result);
    const second = extract(sendMock.mock.calls[1][0]);
    const r = (second.ExpressionAttributeValues as Record<string, WaveResult>)[':r'];
    expect(r.persistedAt).toBe(iso);
  });
});
