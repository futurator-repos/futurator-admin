import { describe, it, expect, vi } from 'vitest';
import { launchVisualQa } from '../visual-qa-launcher';
import type { EpicStory, EpicWorkflow, VisualTestDef } from '../../types/epic-workflow';
import type { AgentJob, PipelineDefinition } from '../../types/agent-orchestrator';

function makeStory(id: string, overrides: Partial<EpicStory> = {}): EpicStory {
  return {
    storyId: id,
    order: Number(id.replace(/\D/g, '')) || 0,
    title: `Story ${id}`,
    description: 'AC body',
    status: 'done',
    wave: 0,
    touchPoints: ['src/a.ts'],
    complexity: 'standard',
    reviewRigor: 'standard',
    ...overrides,
  };
}

function makeEpic(stories: EpicStory[], overrides: Partial<EpicWorkflow> = {}): EpicWorkflow {
  return {
    epicId: 'EPIC-Q',
    title: 'Chrome Dino',
    description: 'desc',
    acceptanceCriteria: '',
    workingDir: '/home/ubuntu/projects/dino',
    status: 'in_progress',
    stories,
    useEpicOrchestrator: false,
    createdAt: '2026-04-20T00:00:00.000Z',
    updatedAt: '2026-04-20T00:00:00.000Z',
    createdBy: 'tester',
    ...overrides,
  };
}

function stubPipeline(): PipelineDefinition {
  return { agents: {}, steps: [] };
}

function vt(id: string, extra: Partial<VisualTestDef> = {}): VisualTestDef {
  return {
    id,
    criteriaRef: 'AC-1',
    description: `Test ${id}`,
    setup: 'Navigate to /',
    expect: 'Element visible',
    ...extra,
  };
}

describe('launchVisualQa', () => {
  it('returns no-visual-tests when no story has any visualTests', async () => {
    const epic = makeEpic([
      makeStory('S-1', { hasBrowserTests: false }),
      makeStory('S-2', { hasBrowserTests: false }),
    ]);
    const createJob = vi.fn(async () => undefined);
    const buildQaPipeline = vi.fn((): PipelineDefinition => stubPipeline());
    const getJobById = vi.fn(async (): Promise<AgentJob | null> => null);
    const parseVisualTests = vi.fn((): VisualTestDef[] => []);

    const result = await launchVisualQa(epic, 'tester', '2026-04-20T00:00:00.000Z', {
      getJobById,
      createJob,
      parseVisualTests,
      buildQaPipeline,
      uuid: () => 'qa-1',
    });

    expect(result).toMatchObject({ ok: false, code: 'no-visual-tests' });
    expect(createJob).not.toHaveBeenCalled();
    expect(buildQaPipeline).not.toHaveBeenCalled();
  });

  it('backfills visualTests from job.variables.VISUAL_TESTS when story has hasBrowserTests + jobId', async () => {
    const epic = makeEpic([
      makeStory('S-1', { hasBrowserTests: true, jobId: 'job-s1' }),
      makeStory('S-2', { hasBrowserTests: false }),
    ]);
    const rawVT = '- id: VT-S1-1\n  criteriaRef: AC-1\n  description: "Dino visible"\n  setup: load\n  expect: pixel';
    const getJobById = vi.fn(async (id: string): Promise<AgentJob | null> => {
      if (id === 'job-s1') {
        return {
          jobId: id,
          status: 'COMPLETED',
          createdAt: '2026-04-20T00:00:00.000Z',
          updatedAt: '2026-04-20T00:00:01.000Z',
          createdBy: 'tester',
          workingDir: '/home/ubuntu/projects/dino',
          pipeline: stubPipeline(),
          variables: { VISUAL_TESTS: rawVT },
        };
      }
      return null;
    });
    const parseVisualTests = vi.fn(() => [vt('VT-S1-1')]);
    const buildQaPipeline = vi.fn((): PipelineDefinition => stubPipeline());
    const createJob = vi.fn(async () => undefined);

    const result = await launchVisualQa(epic, 'tester', '2026-04-20T00:00:00.000Z', {
      getJobById,
      createJob,
      parseVisualTests,
      buildQaPipeline,
      uuid: () => 'qa-2',
    });

    expect(result).toMatchObject({ ok: true, jobId: 'qa-2', storiesChanged: true });
    expect(parseVisualTests).toHaveBeenCalledWith(rawVT);
    expect(buildQaPipeline).toHaveBeenCalledWith(
      '/home/ubuntu/projects/dino',
      'Chrome Dino',
      '1280x720',
      expect.arrayContaining([expect.objectContaining({ id: 'VT-S1-1', storyId: 'S-1' })]),
      expect.stringMatching(/^qa-snapshots\/dino\/qa-2\/$/),
      undefined, // port — omitted, launcher uses default 5173
    );
    expect(createJob).toHaveBeenCalledWith(
      expect.objectContaining({ jobId: 'qa-2', status: 'PENDING' }),
    );
    if (result.ok) {
      const s1 = result.updatedStories.find((s) => s.storyId === 'S-1')!;
      expect(s1.visualTests).toEqual([vt('VT-S1-1')]);
    }
  });

  it('uses testingProfile.viewport when set', async () => {
    const epic = makeEpic(
      [makeStory('S-1', { hasBrowserTests: true, visualTests: [vt('VT-1')] })],
      { testingProfile: { hasBrowserTests: true, viewport: '800x600' } },
    );
    const buildQaPipeline = vi.fn((): PipelineDefinition => stubPipeline());
    const createJob = vi.fn(async () => undefined);

    const result = await launchVisualQa(epic, 'tester', '2026-04-20T00:00:00.000Z', {
      getJobById: async () => null,
      createJob,
      parseVisualTests: () => [],
      buildQaPipeline,
      uuid: () => 'qa-3',
    });

    expect(result).toMatchObject({ ok: true, storiesChanged: false });
    expect(buildQaPipeline).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(String),
      '800x600',
      expect.any(Array),
      expect.stringMatching(/^qa-snapshots\/.+\/qa-3\/$/),
      undefined,
    );
  });

  it('forwards the port option to buildQaPipeline for parallel fan-out', async () => {
    const epic = makeEpic([makeStory('S-1', { hasBrowserTests: true, visualTests: [vt('VT-1')] })]);
    const buildQaPipeline = vi.fn((): PipelineDefinition => stubPipeline());
    const createJob = vi.fn(async () => undefined);

    await launchVisualQa(
      epic,
      'tester',
      '2026-04-20T00:00:00.000Z',
      {
        getJobById: async () => null,
        createJob,
        parseVisualTests: () => [],
        buildQaPipeline,
        uuid: () => 'qa-port',
      },
      { port: 5175 },
    );

    expect(buildQaPipeline).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(String),
      expect.any(String),
      expect.any(Array),
      expect.any(String),
      5175,
    );
  });
});
