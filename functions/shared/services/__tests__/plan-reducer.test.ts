import { describe, it, expect, vi } from 'vitest';
import { reducePlan, type PlanReducerDeps } from '../plan-reducer';
import type { Plan } from '../../types/plan';
import type { EpicWorkflow, EpicStory } from '../../types/epic-workflow';
import type { AgentJob, PipelineDefinition } from '../../types/agent-orchestrator';

function basePlan(overrides: Partial<Plan> = {}): Plan {
  return {
    planId: 'plan-1',
    name: 'pong-classic',
    intent: 'Pong',
    description: 'Pong',
    status: 'developing',
    epicIds: [],
    workingDir: '/home/ubuntu/projects/pong-classic',
    executionMode: 'pipeline',
    totalCostUsd: 0,
    totalStories: 0,
    doneStories: 0,
    createdAt: 'now',
    updatedAt: 'now',
    createdBy: 'tester',
    ...overrides,
  };
}

function epic(id: string, opts: { deps?: string[]; status?: EpicWorkflow['status']; stories?: EpicStory[] } = {}): EpicWorkflow {
  return {
    epicId: id,
    planId: 'plan-1',
    dependsOnEpics: opts.deps || [],
    title: id,
    description: '',
    acceptanceCriteria: '',
    workingDir: '/home/ubuntu/projects/pong-classic',
    status: opts.status || 'draft',
    stories: opts.stories || [],
    createdAt: 'now',
    updatedAt: 'now',
    createdBy: 't',
  };
}

function runningStory(id: string, jobId: string): EpicStory {
  return {
    storyId: id,
    order: 0,
    title: id,
    description: '',
    status: 'running',
    jobId,
    wave: 0,
    touchPoints: [],
    complexity: 'standard',
    reviewRigor: 'standard',
  };
}

function stubPipeline(): PipelineDefinition {
  return { agents: {}, steps: [] };
}

function makeDeps(jobStatuses: Record<string, AgentJob['status']> = {}): {
  deps: PlanReducerDeps;
  updatePlanFields: ReturnType<typeof vi.fn>;
  updateEpicFields: ReturnType<typeof vi.fn>;
  createJob: ReturnType<typeof vi.fn>;
  generatePlanBuildPipeline: ReturnType<typeof vi.fn>;
} {
  let counter = 0;
  const updatePlanFields = vi.fn(async () => undefined);
  const updateEpicFields = vi.fn(async () => undefined);
  const createJob = vi.fn(async () => undefined);
  const generatePlanBuildPipeline = vi.fn((): PipelineDefinition => stubPipeline());
  const deps: PlanReducerDeps = {
    getJobById: async (id: string) =>
      jobStatuses[id]
        ? ({
            jobId: id,
            status: jobStatuses[id],
            createdAt: 'now',
            updatedAt: 'now',
            createdBy: 't',
            workingDir: '/tmp',
            pipeline: stubPipeline(),
          } as AgentJob)
        : null,
    createJob,
    updateEpicFields,
    generatePipeline: vi.fn((): PipelineDefinition => stubPipeline()),
    generateWaveBuildPipeline: vi.fn((): PipelineDefinition => stubPipeline()),
    updatePlanFields,
    generatePlanBuildPipeline,
    uuid: () => `u-${++counter}`,
    now: () => '2026-04-21T12:00:00.000Z',
  };
  return { deps, updatePlanFields, updateEpicFields, createJob, generatePlanBuildPipeline };
}

describe('reducePlan — gating', () => {
  it('no-op when plan has no epics', async () => {
    const { deps } = makeDeps();
    const result = await reducePlan(basePlan({ epicIds: [] }), [], deps);
    expect(result).toEqual({ kind: 'no-op', reason: 'no-epics' });
  });

  it('no-op when plan is not developing or fixing', async () => {
    const { deps } = makeDeps();
    const result = await reducePlan(basePlan({ status: 'review' }), [epic('E1')], deps);
    expect(result).toEqual({ kind: 'no-op', reason: 'plan-terminal' });
  });
});

describe('reducePlan — plan-wave advancement', () => {
  it('flips plan to fixing when any epic is fixing', async () => {
    const epics = [
      epic('E1', { status: 'completed', stories: [{ ...runningStory('s1','j1'), status: 'done' }] }),
      epic('E2', { status: 'fixing' }),
    ];
    const { deps, updatePlanFields } = makeDeps();
    const result = await reducePlan(basePlan(), epics, deps);
    expect(result).toEqual({ kind: 'plan-fixing', reason: 'epic-fixing' });
    expect(updatePlanFields).toHaveBeenCalledWith('plan-1', { status: 'fixing' });
  });

  it('launches plan-wave N+1 when all plan-wave N epics are completed', async () => {
    // E1 (wave 0) completed. E2 (wave 1 depends E1) not yet launched.
    const epics = [
      epic('E1', {
        status: 'completed',
        stories: [{ ...runningStory('s1', 'j1'), status: 'done' }],
      }),
      epic('E2', {
        deps: ['E1'],
        status: 'draft',
        stories: [
          {
            storyId: 's2',
            order: 0,
            title: 's2',
            description: '',
            status: 'pending',
            wave: 0,
            touchPoints: [],
            complexity: 'standard',
            reviewRigor: 'standard',
          },
        ],
      }),
    ];
    const { deps, updateEpicFields } = makeDeps();
    const result = await reducePlan(basePlan(), epics, deps);
    expect(result.kind).toBe('plan-wave-launched');
    if (result.kind === 'plan-wave-launched') {
      expect(result.waveNumber).toBe(1);
      expect(result.epicIds).toEqual(['E2']);
    }
    // Epic E2 should have been set to in_progress.
    expect(updateEpicFields).toHaveBeenCalledWith('E2', expect.objectContaining({ status: 'in_progress' }));
  });

  it('creates plan-build-check when all epics complete and no check exists', async () => {
    const epics = [
      epic('E1', {
        status: 'completed',
        stories: [{ ...runningStory('s1', 'j1'), status: 'done' }],
      }),
    ];
    const { deps, createJob, updatePlanFields, generatePlanBuildPipeline } = makeDeps();
    const result = await reducePlan(basePlan(), epics, deps);
    expect(result.kind).toBe('plan-build-check-created');
    expect(createJob).toHaveBeenCalledOnce();
    expect(generatePlanBuildPipeline).toHaveBeenCalledWith('/home/ubuntu/projects/pong-classic', 'pong-classic');
    expect(updatePlanFields).toHaveBeenCalledWith('plan-1', expect.objectContaining({ planBuildJobId: expect.any(String) }));
  });

  it('is idempotent — if planBuildJobId already set and job is RUNNING, returns pending', async () => {
    const plan = basePlan({ planBuildJobId: 'pbc-1' });
    const epics = [
      epic('E1', {
        status: 'completed',
        stories: [{ ...runningStory('s1', 'j1'), status: 'done' }],
      }),
    ];
    const { deps, createJob } = makeDeps({ 'pbc-1': 'RUNNING' });
    const result = await reducePlan(plan, epics, deps);
    expect(result).toEqual({ kind: 'plan-build-check-pending' });
    expect(createJob).not.toHaveBeenCalled();
  });

  it('flips plan to review when plan-build-check completes', async () => {
    const plan = basePlan({ planBuildJobId: 'pbc-1' });
    const epics = [
      epic('E1', {
        status: 'completed',
        stories: [{ ...runningStory('s1', 'j1'), status: 'done' }],
      }),
    ];
    const { deps, updatePlanFields } = makeDeps({ 'pbc-1': 'COMPLETED' });
    const result = await reducePlan(plan, epics, deps);
    expect(result).toEqual({ kind: 'plan-completed' });
    expect(updatePlanFields).toHaveBeenCalledWith('plan-1', expect.objectContaining({ status: 'review' }));
  });

  it('flips plan to fixing when plan-build-check FAILED', async () => {
    const plan = basePlan({ planBuildJobId: 'pbc-1' });
    const epics = [
      epic('E1', {
        status: 'completed',
        stories: [{ ...runningStory('s1', 'j1'), status: 'done' }],
      }),
    ];
    const { deps, updatePlanFields } = makeDeps({ 'pbc-1': 'FAILED' });
    const result = await reducePlan(plan, epics, deps);
    expect(result).toEqual({ kind: 'plan-fixing', reason: 'build-check-failed' });
    expect(updatePlanFields).toHaveBeenCalledWith('plan-1', { status: 'fixing' });
  });

  // PR-31b — prototype rigor short-circuits the plan-build-check entirely.
  it('skips plan-build-check and flips directly to review for prototype rigor', async () => {
    const plan = basePlan({ rigor: 'prototype' });
    const epics = [
      epic('E1', {
        status: 'completed',
        stories: [{ ...runningStory('s1', 'j1'), status: 'done' }],
      }),
    ];
    const { deps, createJob, updatePlanFields, generatePlanBuildPipeline } = makeDeps();
    const result = await reducePlan(plan, epics, deps);
    expect(result).toEqual({ kind: 'plan-completed' });
    expect(createJob).not.toHaveBeenCalled();
    expect(generatePlanBuildPipeline).not.toHaveBeenCalled();
    expect(updatePlanFields).toHaveBeenCalledWith(
      'plan-1',
      expect.objectContaining({ status: 'review' }),
    );
  });
});
