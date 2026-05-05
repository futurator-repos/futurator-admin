import { describe, it, expect, vi } from 'vitest';
import { buildDevServerPipeline, launchDevServer } from '../dev-server-launcher';
import type { EpicWorkflow } from '../../types/epic-workflow';

function makeEpic(): EpicWorkflow {
  return {
    epicId: 'EPIC-D',
    title: 'Dino',
    description: '',
    acceptanceCriteria: '',
    workingDir: '/home/ubuntu/projects/dino',
    status: 'in_progress',
    stories: [],
    useEpicOrchestrator: false,
    createdAt: '2026-04-20T00:00:00.000Z',
    updatedAt: '2026-04-20T00:00:00.000Z',
    createdBy: 'tester',
  };
}

describe('buildDevServerPipeline', () => {
  it('produces a 1-step OPS agent pipeline with URL/PID/STATUS regex extractors', () => {
    const pipeline = buildDevServerPipeline('/home/ubuntu/projects/foo', '1.2.3.4');
    expect(pipeline.maxIterations).toBe(1);
    expect(Object.keys(pipeline.agents)).toEqual(['OPS']);
    expect(pipeline.steps).toHaveLength(1);

    const step = pipeline.steps[0];
    expect(step.agentId).toBe('OPS');
    expect(step.extractors).toMatchObject({
      DEV_SERVER_URL: expect.objectContaining({ type: 'regex' }),
      DEV_SERVER_PID: expect.objectContaining({ type: 'regex' }),
      STATUS: expect.objectContaining({ type: 'regex' }),
    });
    // Confirms the prompt bakes in the working directory.
    expect(JSON.stringify(pipeline)).toContain('/home/ubuntu/projects/foo');
  });
});

describe('launchDevServer', () => {
  it('creates a PENDING job and returns the jobId', async () => {
    const createJob = vi.fn(async () => undefined);
    const epic = makeEpic();

    const { jobId } = await launchDevServer(epic, 'tester', '2026-04-20T00:00:00.000Z', '1.2.3.4', {
      createJob,
      uuid: () => 'ds-1',
    });

    expect(jobId).toBe('ds-1');
    expect(createJob).toHaveBeenCalledOnce();
    expect(createJob).toHaveBeenCalledWith(
      expect.objectContaining({
        jobId: 'ds-1',
        status: 'PENDING',
        workingDir: '/home/ubuntu/projects/dino',
        createdBy: 'tester',
      }),
    );
  });
});
