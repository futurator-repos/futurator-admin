import { describe, it, expect, vi, beforeEach } from 'vitest';
import { reduceEpicWaves, type WaveReducerDeps } from '../wave-reducer';
import type { EpicStory, EpicWorkflow } from '../../types/epic-workflow';
import type { AgentJob, PipelineDefinition } from '../../types/agent-orchestrator';

// Test fixtures + factories -------------------------------------------------

function makeStory(id: string, wave: number, overrides: Partial<EpicStory> = {}): EpicStory {
  return {
    storyId: id,
    order: Number(id.replace(/\D/g, '')) || 0,
    title: `Story ${id}`,
    description: 'acceptance criteria',
    status: 'pending',
    wave,
    touchPoints: ['src/a.ts'],
    complexity: 'standard',
    reviewRigor: 'standard',
    ...overrides,
  };
}

function makeEpic(stories: EpicStory[], overrides: Partial<EpicWorkflow> = {}): EpicWorkflow {
  return {
    epicId: 'EPIC-1',
    title: 'Ship feature X',
    description: 'goal text',
    acceptanceCriteria: '',
    workingDir: '/home/ubuntu/projects/alpha',
    status: 'in_progress',
    stories,
    useEpicOrchestrator: false,
    createdAt: '2026-04-20T00:00:00.000Z',
    updatedAt: '2026-04-20T00:00:00.000Z',
    createdBy: 'tester',
    devModel: 'sonnet',
    reviewerModel: 'haiku',
    ...overrides,
  };
}

function stubPipeline(): PipelineDefinition {
  return { agents: {}, steps: [] };
}

function fakeJob(jobId: string, status: AgentJob['status']): AgentJob {
  return {
    jobId,
    status,
    createdAt: '2026-04-20T00:00:00.000Z',
    updatedAt: '2026-04-20T00:00:01.000Z',
    createdBy: 'tester',
    workingDir: '/home/ubuntu/projects/alpha',
    pipeline: stubPipeline(),
  };
}

// Dep factory — each test stubs job statuses via a Map lookup.
function makeDeps(
  jobStatuses: Record<string, AgentJob['status']>,
  opts: { uuidSeed?: string } = {},
): {
  deps: WaveReducerDeps;
  getJobById: ReturnType<typeof vi.fn>;
  createJob: ReturnType<typeof vi.fn>;
  updateEpicFields: ReturnType<typeof vi.fn>;
  generateWaveBuildPipeline: ReturnType<typeof vi.fn>;
  generatePipeline: ReturnType<typeof vi.fn>;
  uuid: ReturnType<typeof vi.fn>;
} {
  let counter = 0;
  const getJobById = vi.fn(async (jobId: string): Promise<AgentJob | null> => {
    const status = jobStatuses[jobId];
    return status ? fakeJob(jobId, status) : null;
  });
  const createJob = vi.fn(async () => undefined);
  const updateEpicFields = vi.fn(async () => undefined);
  const generateWaveBuildPipeline = vi.fn((): PipelineDefinition => stubPipeline());
  const generatePipeline = vi.fn((): PipelineDefinition => stubPipeline());
  const uuid = vi.fn(() => `${opts.uuidSeed || 'job'}-${++counter}`);
  const now = () => '2026-04-20T01:00:00.000Z';
  return {
    deps: {
      getJobById,
      createJob,
      updateEpicFields,
      generateWaveBuildPipeline,
      generatePipeline,
      uuid,
      now,
    },
    getJobById,
    createJob,
    updateEpicFields,
    generateWaveBuildPipeline,
    generatePipeline,
    uuid,
  };
}

// Tests ---------------------------------------------------------------------

beforeEach(() => {
  vi.clearAllMocks();
});

describe('reduceEpicWaves — gating', () => {
  it('no-op when stories array is empty', async () => {
    const epic = makeEpic([]);
    const { deps } = makeDeps({});
    const result = await reduceEpicWaves(epic, deps);
    expect(result).toEqual({ kind: 'no-op', reason: 'no-stories' });
  });

  it('no-op when no story has been launched yet (no jobId)', async () => {
    const epic = makeEpic([makeStory('S-1', 0), makeStory('S-2', 0)]);
    const { deps } = makeDeps({});
    const result = await reduceEpicWaves(epic, deps);
    expect(result).toEqual({ kind: 'no-op', reason: 'no-current-wave' });
  });

  it('no-op while any current-wave job is still RUNNING', async () => {
    const epic = makeEpic([
      makeStory('S-1', 0, { jobId: 'j-1', status: 'running' }),
      makeStory('S-2', 0, { jobId: 'j-2', status: 'running' }),
    ]);
    const { deps, updateEpicFields, createJob } = makeDeps({
      'j-1': 'COMPLETED',
      'j-2': 'RUNNING',
    });
    const result = await reduceEpicWaves(epic, deps);
    expect(result).toEqual({ kind: 'no-op', reason: 'wave-running' });
    expect(updateEpicFields).not.toHaveBeenCalled();
    expect(createJob).not.toHaveBeenCalled();
  });
});

describe('reduceEpicWaves — NEEDS_ATTENTION pausing (Story 1.1)', () => {
  it('returns wave-paused when any current-wave job is NEEDS_ATTENTION; does not advance, does not flip status', async () => {
    const epic = makeEpic([
      makeStory('S-1', 0, { jobId: 'j-1', status: 'running' }),
      makeStory('S-2', 0, { jobId: 'j-2', status: 'running' }),
    ]);
    const { deps, updateEpicFields, createJob } = makeDeps({
      'j-1': 'COMPLETED',
      'j-2': 'NEEDS_ATTENTION',
    });
    const result = await reduceEpicWaves(epic, deps);
    expect(result).toEqual({
      kind: 'wave-paused',
      waveNumber: 0,
      needsAttentionStoryIds: ['S-2'],
    });
    // Does not propagate: epic row is not mutated, no build-check is created.
    expect(updateEpicFields).not.toHaveBeenCalled();
    expect(createJob).not.toHaveBeenCalled();
  });

  it('treats COMPLETED_VIA_SALVAGE as success — wave advances to build-check', async () => {
    const epic = makeEpic([
      makeStory('S-1', 0, { jobId: 'j-1', status: 'running' }),
      makeStory('S-2', 0, { jobId: 'j-2', status: 'running' }),
    ]);
    const { deps, createJob } = makeDeps(
      { 'j-1': 'COMPLETED', 'j-2': 'COMPLETED_VIA_SALVAGE' },
      { uuidSeed: 'build' },
    );
    const result = await reduceEpicWaves(epic, deps);
    expect(result.kind).toBe('wave-build-check-created');
    expect(createJob).toHaveBeenCalledTimes(1);
  });

  it('treats MANUALLY_SKIPPED as success — wave advances to build-check', async () => {
    const epic = makeEpic([
      makeStory('S-1', 0, { jobId: 'j-1', status: 'running' }),
      makeStory('S-2', 0, { jobId: 'j-2', status: 'running' }),
    ]);
    const { deps, createJob } = makeDeps(
      { 'j-1': 'COMPLETED', 'j-2': 'MANUALLY_SKIPPED' },
      { uuidSeed: 'build' },
    );
    const result = await reduceEpicWaves(epic, deps);
    expect(result.kind).toBe('wave-build-check-created');
    expect(createJob).toHaveBeenCalledTimes(1);
  });
});

describe('reduceEpicWaves — wave completion → build-check', () => {
  it('creates wave-build-check when all current-wave jobs COMPLETED and no build-check exists', async () => {
    const epic = makeEpic([
      makeStory('S-1', 0, { jobId: 'j-1', status: 'running' }),
      makeStory('S-2', 0, { jobId: 'j-2', status: 'running' }),
      makeStory('S-3', 1), // wave 2, not yet launched
    ]);
    const { deps, createJob, updateEpicFields, generateWaveBuildPipeline } = makeDeps(
      { 'j-1': 'COMPLETED', 'j-2': 'COMPLETED' },
      { uuidSeed: 'build' },
    );

    const result = await reduceEpicWaves(epic, deps);

    expect(result).toEqual({
      kind: 'wave-build-check-created',
      waveNumber: 0,
      jobId: 'build-1',
    });
    expect(createJob).toHaveBeenCalledOnce();
    expect(createJob).toHaveBeenCalledWith(
      expect.objectContaining({
        jobId: 'build-1',
        status: 'PENDING',
        workingDir: '/home/ubuntu/projects/alpha',
      }),
    );
    expect(generateWaveBuildPipeline).toHaveBeenCalledWith(
      '/home/ubuntu/projects/alpha',
      0,
      ['Story S-1', 'Story S-2'],
      // PR-68 — fourth arg is the required-sources list (deduped touch
      // points from the wave's stories, filtered to src/ paths).
      ['src/a.ts'],
    );
    expect(updateEpicFields).toHaveBeenCalledWith(
      'EPIC-1',
      expect.objectContaining({
        waveBuildJobs: { '0': 'build-1' },
        stories: expect.arrayContaining([
          expect.objectContaining({ storyId: 'S-1', status: 'done' }),
          expect.objectContaining({ storyId: 'S-2', status: 'done' }),
        ]),
      }),
    );
  });

  it('is idempotent — re-running with build-check already created does NOT create another', async () => {
    const epic = makeEpic(
      [
        makeStory('S-1', 0, { jobId: 'j-1', status: 'done' }),
        makeStory('S-2', 0, { jobId: 'j-2', status: 'done' }),
      ],
      { waveBuildJobs: { '0': 'build-1' } },
    );
    const { deps, createJob, updateEpicFields } = makeDeps({
      'j-1': 'COMPLETED',
      'j-2': 'COMPLETED',
      'build-1': 'RUNNING', // build-check still running
    });

    const result = await reduceEpicWaves(epic, deps);

    expect(result).toEqual({ kind: 'wave-build-check-pending', waveNumber: 0 });
    expect(createJob).not.toHaveBeenCalled();
    expect(updateEpicFields).not.toHaveBeenCalled();
  });
});

describe('reduceEpicWaves — failure paths', () => {
  it('sets epic.status = "fixing" when any current-wave story failed, and does NOT create a build-check', async () => {
    const epic = makeEpic([
      makeStory('S-1', 0, { jobId: 'j-1', status: 'running' }),
      makeStory('S-2', 0, { jobId: 'j-2', status: 'running' }),
    ]);
    const { deps, createJob, updateEpicFields } = makeDeps({
      'j-1': 'COMPLETED',
      'j-2': 'FAILED',
    });

    const result = await reduceEpicWaves(epic, deps);

    expect(result).toEqual({
      kind: 'wave-failed',
      waveNumber: 0,
      failedStoryIds: ['S-2'],
    });
    expect(createJob).not.toHaveBeenCalled();
    expect(updateEpicFields).toHaveBeenCalledWith(
      'EPIC-1',
      expect.objectContaining({
        status: 'fixing',
        stories: expect.arrayContaining([
          expect.objectContaining({ storyId: 'S-1', status: 'done' }),
          expect.objectContaining({ storyId: 'S-2', status: 'failed' }),
        ]),
      }),
    );
  });

  it('sets epic.status = "fixing" when wave-build-check fails', async () => {
    const epic = makeEpic(
      [
        makeStory('S-1', 0, { jobId: 'j-1', status: 'done' }),
        makeStory('S-2', 0, { jobId: 'j-2', status: 'done' }),
      ],
      { waveBuildJobs: { '0': 'build-1' } },
    );
    const { deps, createJob, updateEpicFields } = makeDeps({
      'j-1': 'COMPLETED',
      'j-2': 'COMPLETED',
      'build-1': 'FAILED',
    });

    const result = await reduceEpicWaves(epic, deps);

    expect(result).toEqual({ kind: 'wave-build-check-failed', waveNumber: 0 });
    expect(createJob).not.toHaveBeenCalled();
    expect(updateEpicFields).toHaveBeenCalledWith(
      'EPIC-1',
      expect.objectContaining({ status: 'fixing' }),
    );
  });
});

// pong1 P3 (2026-06-12) — story-failure cards are write-once per failure
// STATE. The dedupKey already capped rows at 1, but every cron tick over a
// 'fixing' epic re-upserted the same card and bumped recurrenceCount (rec=36
// on one unchanged failure). The card now writes only when the persisted
// story status TRANSITIONS to 'failed'.
describe('pong1 P3 — story-failure cards write-once per failure state', () => {
  it('writes the card on the →failed transition, then stays silent on repeat ticks', async () => {
    const writeAttentionItem = vi.fn(async () => undefined);

    // Tick 1: persisted story status is 'developing'; its job FAILED.
    const epic1 = makeEpic([makeStory('S-1', 0, { jobId: 'j-1', status: 'running' })], {
      planId: 'plan-1',
    } as Partial<EpicWorkflow>);
    const { deps: deps1 } = makeDeps({ 'j-1': 'FAILED' });
    const r1 = await reduceEpicWaves(epic1, { ...deps1, writeAttentionItem });
    expect(r1.kind).toBe('wave-failed');
    expect(writeAttentionItem).toHaveBeenCalledTimes(1);
    expect(writeAttentionItem).toHaveBeenCalledWith(
      expect.objectContaining({
        category: 'test-gate-failed',
        dedupKey: 'wave-reducer:test-gate-failed:S-1',
      }),
    );

    // Tick 2 (cron re-reduce): the epic row now persists status 'failed' for
    // the same story — same failure state, NO new upsert.
    writeAttentionItem.mockClear();
    const epic2 = makeEpic([makeStory('S-1', 0, { jobId: 'j-1', status: 'failed' })], {
      planId: 'plan-1',
      status: 'fixing',
    } as Partial<EpicWorkflow>);
    const { deps: deps2 } = makeDeps({ 'j-1': 'FAILED' });
    const r2 = await reduceEpicWaves(epic2, { ...deps2, writeAttentionItem });
    expect(r2.kind).toBe('wave-failed');
    expect(writeAttentionItem).not.toHaveBeenCalled();
  });

  it('a retried story that fails AGAIN re-writes the card (state transitioned twice)', async () => {
    const writeAttentionItem = vi.fn(async () => undefined);
    // After an operator retry the story is re-launched: persisted status is
    // 'developing' again with a fresh job that failed → transition fires.
    const epic = makeEpic([makeStory('S-1', 0, { jobId: 'j-retry', status: 'running' })], {
      planId: 'plan-1',
      status: 'fixing',
    } as Partial<EpicWorkflow>);
    const { deps } = makeDeps({ 'j-retry': 'FAILED' });
    await reduceEpicWaves(epic, { ...deps, writeAttentionItem });
    expect(writeAttentionItem).toHaveBeenCalledTimes(1);
  });
});

describe('reduceEpicWaves — next-wave advancement', () => {
  it('launches wave N+1 when build-check COMPLETED and nextWaveStories exist', async () => {
    const epic = makeEpic(
      [
        makeStory('S-1', 0, { jobId: 'j-1', status: 'done' }),
        makeStory('S-2', 0, { jobId: 'j-2', status: 'done' }),
        makeStory('S-3', 1),
        makeStory('S-4', 1),
      ],
      { waveBuildJobs: { '0': 'build-1' } },
    );
    const { deps, createJob, updateEpicFields, generatePipeline } = makeDeps(
      {
        'j-1': 'COMPLETED',
        'j-2': 'COMPLETED',
        'build-1': 'COMPLETED',
      },
      { uuidSeed: 'next' },
    );

    const result = await reduceEpicWaves(epic, deps);

    expect(result).toMatchObject({
      kind: 'next-wave-launched',
      waveNumber: 1,
      jobIds: ['next-1', 'next-2'],
    });
    expect(createJob).toHaveBeenCalledTimes(2);
    expect(generatePipeline).toHaveBeenCalledTimes(2);
    // Per-story pipelines launched for S-3 and S-4 (wave 1).
    expect(generatePipeline.mock.calls.map((c) => (c[0] as EpicStory).storyId).sort()).toEqual([
      'S-3',
      'S-4',
    ]);
    expect(updateEpicFields).toHaveBeenCalledWith(
      'EPIC-1',
      expect.objectContaining({
        status: 'in_progress',
        stories: expect.arrayContaining([
          expect.objectContaining({ storyId: 'S-3', jobId: 'next-1', status: 'queued' }),
          expect.objectContaining({ storyId: 'S-4', jobId: 'next-2', status: 'queued' }),
        ]),
      }),
    );
  });

  // v2.6 M5 (2026-06-11) — the wave gate's fix-forward path APPENDS an
  // auto-minted story at wave max+1 (origin: 'wave-vqa-fix') after the gate
  // job completes. This pins the zero-new-machinery property the design
  // relies on: the reducer launches an appended story exactly like any
  // PM-authored next-wave story.
  it('launches an auto-minted wave-vqa-fix story appended at wave N+1 (M5)', async () => {
    const epic = makeEpic(
      [
        makeStory('S-1', 0, { jobId: 'j-1', status: 'done' }),
        makeStory('FIX-1', 1, {
          origin: 'wave-vqa-fix',
          dependsOn: ['S-1'],
          hasBrowserTests: true,
          criteria: [{ id: 'AC-1', text: 'the surface is visible at load', needsBrowser: true }],
        }),
      ],
      { waveBuildJobs: { '0': 'gate-1' } },
    );
    const { deps, createJob, generatePipeline } = makeDeps(
      { 'j-1': 'COMPLETED', 'gate-1': 'COMPLETED' },
      { uuidSeed: 'fix' },
    );

    const result = await reduceEpicWaves(epic, deps);

    expect(result).toMatchObject({ kind: 'next-wave-launched', waveNumber: 1 });
    expect(createJob).toHaveBeenCalledTimes(1);
    expect((generatePipeline.mock.calls[0][0] as EpicStory).storyId).toBe('FIX-1');
    expect((generatePipeline.mock.calls[0][0] as EpicStory).origin).toBe('wave-vqa-fix');
  });

  it('marks epic.status = "completed" when build-check COMPLETED and no next wave exists', async () => {
    const epic = makeEpic(
      [
        makeStory('S-1', 0, { jobId: 'j-1', status: 'done' }),
        makeStory('S-2', 0, { jobId: 'j-2', status: 'done' }),
      ],
      { waveBuildJobs: { '0': 'build-1' } },
    );
    const { deps, createJob, updateEpicFields } = makeDeps({
      'j-1': 'COMPLETED',
      'j-2': 'COMPLETED',
      'build-1': 'COMPLETED',
    });

    const result = await reduceEpicWaves(epic, deps);

    expect(result).toEqual({ kind: 'epic-completed' });
    expect(createJob).not.toHaveBeenCalled(); // no new story jobs
    expect(updateEpicFields).toHaveBeenCalledWith(
      'EPIC-1',
      expect.objectContaining({ status: 'completed' }),
    );
  });
});
