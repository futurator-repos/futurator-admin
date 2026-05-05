import { describe, it, expect, vi, beforeEach } from 'vitest';
import { launchPipelineWave, findFirstWave } from '../pipeline-launcher';
import type { EpicStory, EpicWorkflow } from '../../types/epic-workflow';
import type { PipelineDefinition } from '../../types/agent-orchestrator';

// Tests for Story 16.1 + 16.2. `launchPipelineWave` accepts an explicit wave
// number (16.2). `findFirstWave` is a small helper for `/start` and
// `/from-xml` autoStart.

function makeStory(id: string, wave: number, overrides: Partial<EpicStory> = {}): EpicStory {
  return {
    storyId: id,
    order: Number(id.replace(/\D/g, '')) || 0,
    title: `Story ${id}`,
    description: 'acceptance criteria etc.',
    status: 'pending',
    wave,
    touchPoints: ['src/a.ts'],
    complexity: 'standard',
    reviewRigor: 'standard',
    ...overrides,
  };
}

function makeEpic(stories: EpicStory[]): Pick<
  EpicWorkflow,
  | 'epicId'
  | 'title'
  | 'workingDir'
  | 'stories'
  | 'devModel'
  | 'devEffort'
  | 'reviewerModel'
  | 'reviewerEffort'
> {
  return {
    epicId: 'EPIC-1',
    title: 'Ship feature X',
    workingDir: '/home/ubuntu/projects/alpha',
    stories,
    devModel: 'sonnet',
    devEffort: 'standard',
    reviewerModel: 'haiku',
    reviewerEffort: 'light',
  };
}

function stubPipeline(): PipelineDefinition {
  return { agents: {}, steps: [] };
}

describe('findFirstWave', () => {
  it('returns the minimum wave across stories', () => {
    const epic = makeEpic([makeStory('S-1', 3), makeStory('S-2', 0), makeStory('S-3', 5)]);
    expect(findFirstWave(epic)).toBe(0);
  });

  it('treats undefined wave as 0', () => {
    const epic = makeEpic([
      makeStory('S-1', 2),
      { ...makeStory('S-2', 0), wave: undefined },
    ]);
    expect(findFirstWave(epic)).toBe(0);
  });

  it('when all stories share a non-zero wave, returns that wave', () => {
    const epic = makeEpic([makeStory('S-1', 3), makeStory('S-2', 3)]);
    expect(findFirstWave(epic)).toBe(3);
  });

  it('throws when stories array is empty', () => {
    const epic = makeEpic([]);
    expect(() => findFirstWave(epic)).toThrow(/no stories/);
  });
});

describe('launchPipelineWave', () => {
  let generatePipeline: ReturnType<typeof vi.fn>;
  let createJob: ReturnType<typeof vi.fn>;
  let uuid: ReturnType<typeof vi.fn>;
  let uuidCounter: number;

  beforeEach(() => {
    uuidCounter = 0;
    generatePipeline = vi.fn((): PipelineDefinition => stubPipeline());
    createJob = vi.fn(async () => ({}));
    uuid = vi.fn(() => `job-${++uuidCounter}`);
  });

  it('creates one job when the targeted wave has one story', async () => {
    const epic = makeEpic([makeStory('S-1', 0)]);

    const result = await launchPipelineWave(epic, 0, 'alice', '2026-04-20T00:00:00Z', {
      generatePipeline,
      createJob,
      uuid,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.jobIds).toEqual(['job-1']);
    expect(result.waveNumber).toBe(0);
    expect(result.updatedStories).toHaveLength(1);
    expect(result.updatedStories[0].jobId).toBe('job-1');
    expect(result.updatedStories[0].status).toBe('queued');
    expect(createJob).toHaveBeenCalledOnce();
    expect(createJob).toHaveBeenCalledWith(
      expect.objectContaining({
        jobId: 'job-1',
        status: 'PENDING',
        workingDir: '/home/ubuntu/projects/alpha',
        createdBy: 'alice',
      }),
    );
  });

  it('creates N jobs in parallel for a multi-story wave and leaves other waves untouched', async () => {
    const epic = makeEpic([
      makeStory('S-1', 0),
      makeStory('S-2', 0),
      makeStory('S-3', 0),
      makeStory('S-4', 1), // wave 2 — should NOT be enqueued
    ]);

    const result = await launchPipelineWave(epic, 0, 'alice', '2026-04-20T00:00:00Z', {
      generatePipeline,
      createJob,
      uuid,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.jobIds).toEqual(['job-1', 'job-2', 'job-3']);
    expect(createJob).toHaveBeenCalledTimes(3);

    const byId = new Map(result.updatedStories.map((s) => [s.storyId, s]));
    expect(byId.get('S-1')?.jobId).toBe('job-1');
    expect(byId.get('S-1')?.status).toBe('queued');
    expect(byId.get('S-4')?.jobId).toBeUndefined();
    expect(byId.get('S-4')?.status).toBe('pending');
  });

  it('launches a non-first wave without disturbing already-launched earlier waves', async () => {
    // Simulate the state AFTER wave 0 has run: S-1 and S-2 have jobId and
    // status='done'. The cron now calls launchPipelineWave(epic, 1, ...) to
    // kick wave 1.
    const epic = makeEpic([
      makeStory('S-1', 0, { jobId: 'prev-1', status: 'done' }),
      makeStory('S-2', 0, { jobId: 'prev-2', status: 'done' }),
      makeStory('S-3', 1),
      makeStory('S-4', 1),
    ]);

    const result = await launchPipelineWave(epic, 1, 'alice', '2026-04-20T00:00:00Z', {
      generatePipeline,
      createJob,
      uuid,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.waveNumber).toBe(1);
    expect(result.jobIds).toEqual(['job-1', 'job-2']);

    const byId = new Map(result.updatedStories.map((s) => [s.storyId, s]));
    // Wave 0 stories preserved verbatim:
    expect(byId.get('S-1')?.jobId).toBe('prev-1');
    expect(byId.get('S-1')?.status).toBe('done');
    expect(byId.get('S-2')?.jobId).toBe('prev-2');
    expect(byId.get('S-2')?.status).toBe('done');
    // Wave 1 stories newly launched:
    expect(byId.get('S-3')?.jobId).toBe('job-1');
    expect(byId.get('S-3')?.status).toBe('queued');
    expect(byId.get('S-4')?.jobId).toBe('job-2');
  });

  it('returns no-wave-stories when the targeted wave has zero matching stories', async () => {
    const epic = makeEpic([makeStory('S-1', 0)]);

    const result = await launchPipelineWave(epic, 5, 'alice', '2026-04-20T00:00:00Z', {
      generatePipeline,
      createJob,
      uuid,
    });

    expect(result).toEqual({
      ok: false,
      code: 'no-wave-stories',
      message: 'Epic has no stories in wave 5 to start',
    });
    expect(createJob).not.toHaveBeenCalled();
  });

  it('returns no-wave-stories when the stories array is empty', async () => {
    const epic = makeEpic([]);

    const result = await launchPipelineWave(epic, 0, 'alice', '2026-04-20T00:00:00Z', {
      generatePipeline,
      createJob,
      uuid,
    });

    expect(result).toEqual({
      ok: false,
      code: 'no-wave-stories',
      message: 'Epic has no stories to start',
    });
    expect(createJob).not.toHaveBeenCalled();
  });

  it('does not mutate the caller-supplied stories array', async () => {
    const input = [makeStory('S-1', 0)];
    const frozen = JSON.parse(JSON.stringify(input));

    await launchPipelineWave(makeEpic(input), 0, 'alice', '2026-04-20T00:00:00Z', {
      generatePipeline,
      createJob,
      uuid,
    });

    expect(input).toEqual(frozen);
    expect(input[0].jobId).toBeUndefined();
    expect(input[0].status).toBe('pending');
  });
});
