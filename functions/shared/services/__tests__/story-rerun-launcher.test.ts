import { describe, it, expect, vi } from 'vitest';
import { launchStoryRerun } from '../story-rerun-launcher';
import type { EpicStory, EpicWorkflow } from '../../types/epic-workflow';
import type { PipelineDefinition } from '../../types/agent-orchestrator';

function makeStory(id: string, overrides: Partial<EpicStory> = {}): EpicStory {
  return {
    storyId: id,
    order: Number(id.replace(/\D/g, '')) || 0,
    title: `Story ${id}`,
    description: 'AC body',
    status: 'failed',
    jobId: `old-${id}`,
    wave: 0,
    touchPoints: ['src/a.ts'],
    complexity: 'standard',
    reviewRigor: 'standard',
    ...overrides,
  };
}

function makeEpic(stories: EpicStory[]): EpicWorkflow {
  return {
    epicId: 'EPIC-X',
    title: 'Some Feature',
    description: 'desc',
    acceptanceCriteria: '',
    workingDir: '/home/ubuntu/projects/x',
    status: 'in_progress',
    stories,
    useEpicOrchestrator: false,
    createdAt: '2026-04-20T00:00:00.000Z',
    updatedAt: '2026-04-20T00:00:00.000Z',
    createdBy: 'tester',
    devModel: 'sonnet',
    reviewerModel: 'haiku',
  };
}

function stubPipeline(): PipelineDefinition {
  return { agents: {}, steps: [] };
}

describe('launchStoryRerun', () => {
  it('creates PENDING job for target story and updates only that story', async () => {
    const epic = makeEpic([
      makeStory('S-1', { status: 'done', jobId: 'keep-1' }),
      makeStory('S-2', { status: 'failed', jobId: 'fail-2' }),
      makeStory('S-3', { status: 'done', jobId: 'keep-3' }),
    ]);
    const createJob = vi.fn(async () => undefined);
    const generatePipeline = vi.fn(
      (story: EpicStory): PipelineDefinition => ({
        agents: { DEV: { name: story.storyId, allowedTools: 'Bash' } },
        steps: [],
      }),
    );

    const result = await launchStoryRerun(epic, 'S-2', 'tester', '2026-04-20T00:00:00.000Z', {
      generatePipeline,
      createJob,
      uuid: () => 'new-job',
    });

    expect(result).toMatchObject({ ok: true, jobId: 'new-job' });
    expect(generatePipeline).toHaveBeenCalledWith(
      expect.objectContaining({ storyId: 'S-2' }),
      'Some Feature',
      '/home/ubuntu/projects/x',
      expect.objectContaining({ epicId: 'EPIC-X', devModel: 'sonnet' }),
    );
    expect(createJob).toHaveBeenCalledWith(
      expect.objectContaining({ jobId: 'new-job', status: 'PENDING' }),
    );
    if (result.ok) {
      const s1 = result.updatedStories.find((s) => s.storyId === 'S-1')!;
      const s2 = result.updatedStories.find((s) => s.storyId === 'S-2')!;
      const s3 = result.updatedStories.find((s) => s.storyId === 'S-3')!;
      // Only S-2 mutated.
      expect(s1).toEqual(epic.stories[0]);
      expect(s3).toEqual(epic.stories[2]);
      expect(s2.jobId).toBe('new-job');
      expect(s2.status).toBe('queued');
    }
  });

  it('sets retryOf to the prior attempt jobId so its events stay reachable (F2)', async () => {
    const epic = makeEpic([makeStory('S-2', { status: 'failed', jobId: 'fail-2' })]);
    const createJob = vi.fn(async () => undefined);

    const result = await launchStoryRerun(epic, 'S-2', 'tester', '2026-04-20T00:00:00.000Z', {
      generatePipeline: () => stubPipeline(),
      createJob,
      uuid: () => 'new-job',
    });

    expect(result).toMatchObject({ ok: true, jobId: 'new-job' });
    // New job chains back to the prior attempt's job (captured before story.jobId
    // is overwritten with 'new-job' in updatedStories).
    expect(createJob).toHaveBeenCalledWith(expect.objectContaining({ retryOf: 'fail-2' }));
  });

  it('omits retryOf when the story has no prior jobId (first launch)', async () => {
    const epic = makeEpic([makeStory('S-2', { status: 'pending', jobId: undefined })]);
    const createJob = vi.fn(async () => undefined);

    await launchStoryRerun(epic, 'S-2', 'tester', '2026-04-20T00:00:00.000Z', {
      generatePipeline: () => stubPipeline(),
      createJob,
      uuid: () => 'new-job',
    });

    const jobArg = (createJob.mock.calls[0] as unknown[])[0] as Record<string, unknown>;
    expect('retryOf' in jobArg).toBe(false);
  });

  it('returns story-not-found when storyId does not match any story', async () => {
    const epic = makeEpic([makeStory('S-1')]);
    const createJob = vi.fn(async () => undefined);
    const generatePipeline = vi.fn((): PipelineDefinition => stubPipeline());

    const result = await launchStoryRerun(epic, 'S-NOPE', 'tester', '2026-04-20T00:00:00.000Z', {
      generatePipeline,
      createJob,
      uuid: () => 'n-1',
    });

    expect(result).toEqual({
      ok: false,
      code: 'story-not-found',
      message: expect.stringContaining('S-NOPE'),
    });
    expect(createJob).not.toHaveBeenCalled();
    expect(generatePipeline).not.toHaveBeenCalled();
  });
});
