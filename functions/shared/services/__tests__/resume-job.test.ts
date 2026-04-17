import { describe, it, expect, vi } from 'vitest';
import { enqueueResumeJob } from '../resume-job';
import type { AgentJob, WaveResult } from '../../types/agent-orchestrator';
import type { EpicWorkflow } from '../../types/epic-workflow';

function makeEpic(overrides: Partial<EpicWorkflow> = {}): EpicWorkflow {
  return {
    epicId: 'EPIC-42',
    title: 'Cost charts redesign',
    description: 'Add timezone-aware aggregation',
    acceptanceCriteria: 'All charts render UTC',
    workingDir: '/home/ubuntu/projects/cost-charts',
    status: 'in_progress',
    stories: [
      {
        storyId: 'STORY-1',
        order: 0,
        title: 'Add aggregation helper',
        description: 'Pure function',
        status: 'pending',
        wave: 1,
        touchPoints: ['src/lib/aggregate.ts'],
        complexity: 'standard',
        reviewRigor: 'standard',
      },
    ],
    useEpicOrchestrator: true,
    createdAt: '2026-04-17T00:00:00.000Z',
    updatedAt: '2026-04-17T00:00:00.000Z',
    createdBy: 'user-1',
    ...overrides,
  };
}

function makeJob(overrides: Partial<AgentJob> = {}): AgentJob {
  return {
    jobId: 'PRIOR-JOB',
    status: 'FAILED',
    createdAt: '2026-04-17T00:00:00.000Z',
    updatedAt: '2026-04-17T00:10:00.000Z',
    createdBy: 'user-1',
    workingDir: '/home/ubuntu/projects/cost-charts',
    pipeline: { agents: {}, steps: [] },
    phase: 'epic-dev',
    ...overrides,
  };
}

function makeWaveResult(waveNumber: number): WaveResult {
  return {
    waveNumber,
    stories: {},
    durationMs: 1000,
    completedAt: Date.now(),
  };
}

describe('enqueueResumeJob', () => {
  it('creates a phase:epic-dev PENDING job and returns the new jobId', async () => {
    const createJob = vi.fn().mockImplementation(async (j: AgentJob) => j);
    const deps = {
      getEpicById: vi.fn().mockResolvedValue(makeEpic()),
      getJobById: vi.fn().mockResolvedValue(null),
      createJob,
      newJobId: () => 'NEW-JOB-ID',
      now: () => new Date('2026-04-17T12:00:00.000Z'),
    };

    const result = await enqueueResumeJob({ epicId: 'EPIC-42', userId: 'user-1' }, deps);

    expect(result.jobId).toBe('NEW-JOB-ID');
    expect(createJob).toHaveBeenCalledOnce();
    const created = createJob.mock.calls[0][0] as AgentJob;
    expect(created.jobId).toBe('NEW-JOB-ID');
    expect(created.status).toBe('PENDING');
    expect(created.phase).toBe('epic-dev');
    expect(created.epicId).toBe('EPIC-42');
    expect(created.workingDir).toBe('/home/ubuntu/projects/cost-charts');
    expect(created.createdBy).toBe('user-1');
    expect(created.epicDevPayload).toBeDefined();
    expect(created.epicDevPayload?.stories).toHaveLength(1);
  });

  it('carries resumeFromWaveResults from the prior job when populated', async () => {
    const priorWaveResults = { '1': makeWaveResult(1) };
    const createJob = vi.fn().mockImplementation(async (j: AgentJob) => j);
    const deps = {
      getEpicById: vi.fn().mockResolvedValue(makeEpic()),
      getJobById: vi.fn().mockResolvedValue(makeJob({ waveResults: priorWaveResults })),
      createJob,
      newJobId: () => 'NEW-JOB',
      now: () => new Date('2026-04-17T12:00:00.000Z'),
    };

    const result = await enqueueResumeJob(
      { epicId: 'EPIC-42', userId: 'user-1', priorJobId: 'PRIOR-JOB' },
      deps,
    );

    expect(result.resumeFromWaveResults).toEqual(priorWaveResults);
    const created = createJob.mock.calls[0][0] as AgentJob;
    expect(created.resumeFromWaveResults).toEqual(priorWaveResults);
  });

  it('omits resumeFromWaveResults when prior job has empty waveResults', async () => {
    const createJob = vi.fn().mockImplementation(async (j: AgentJob) => j);
    const deps = {
      getEpicById: vi.fn().mockResolvedValue(makeEpic()),
      getJobById: vi.fn().mockResolvedValue(makeJob({ waveResults: {} })),
      createJob,
      newJobId: () => 'NEW-JOB',
      now: () => new Date('2026-04-17T12:00:00.000Z'),
    };

    const result = await enqueueResumeJob(
      { epicId: 'EPIC-42', userId: 'user-1', priorJobId: 'PRIOR-JOB' },
      deps,
    );

    expect(result.resumeFromWaveResults).toEqual({});
    const created = createJob.mock.calls[0][0] as AgentJob;
    expect(created.resumeFromWaveResults).toBeUndefined();
  });

  it('omits resumeFromWaveResults when prior job does not exist', async () => {
    const createJob = vi.fn().mockImplementation(async (j: AgentJob) => j);
    const deps = {
      getEpicById: vi.fn().mockResolvedValue(makeEpic()),
      getJobById: vi.fn().mockResolvedValue(null),
      createJob,
      newJobId: () => 'NEW-JOB',
      now: () => new Date('2026-04-17T12:00:00.000Z'),
    };

    await enqueueResumeJob({ epicId: 'EPIC-42', userId: 'user-1', priorJobId: 'MISSING' }, deps);

    const created = createJob.mock.calls[0][0] as AgentJob;
    expect(created.resumeFromWaveResults).toBeUndefined();
  });

  it('throws when the epic does not exist', async () => {
    const deps = {
      getEpicById: vi.fn().mockResolvedValue(null),
      getJobById: vi.fn(),
      createJob: vi.fn(),
      newJobId: () => 'NEW-JOB',
      now: () => new Date('2026-04-17T12:00:00.000Z'),
    };

    await expect(enqueueResumeJob({ epicId: 'MISSING', userId: 'user-1' }, deps)).rejects.toThrow(
      /not found/,
    );
  });

  it('derives projectId from workingDir trailing segment', async () => {
    const createJob = vi.fn().mockImplementation(async (j: AgentJob) => j);
    const deps = {
      getEpicById: vi
        .fn()
        .mockResolvedValue(makeEpic({ workingDir: '/home/ubuntu/projects/my-app/' })),
      getJobById: vi.fn().mockResolvedValue(null),
      createJob,
      newJobId: () => 'NEW-JOB',
      now: () => new Date('2026-04-17T12:00:00.000Z'),
    };

    await enqueueResumeJob({ epicId: 'EPIC-42', userId: 'user-1' }, deps);

    const created = createJob.mock.calls[0][0] as AgentJob;
    expect(created.projectId).toBe('my-app');
  });
});
