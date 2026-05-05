import { describe, it, expect, vi } from 'vitest';
import { parsePlanOutput, applyPlanOutput } from '../plan-generation-service';
import { planOutputSchema, validatePlanReferences } from '../../schemas/plan-output-schema';
import type { Plan } from '../../types/plan';
import type { AgentJob, PipelineDefinition } from '../../types/agent-orchestrator';

function basePlan(overrides: Partial<Plan> = {}): Plan {
  return {
    planId: 'plan-1',
    name: 'pong-classic',
    intent: 'Pong game',
    description: '',
    status: 'concept',
    epicIds: [],
    workingDir: '/home/ubuntu/projects/pong-classic',
    executionMode: 'pipeline',
    totalCostUsd: 0,
    totalStories: 0,
    doneStories: 0,
    createdAt: '2026-04-21T00:00:00.000Z',
    updatedAt: '2026-04-21T00:00:00.000Z',
    createdBy: 'tester',
    ...overrides,
  };
}

function baseJob(variables: Record<string, string>): AgentJob {
  return {
    jobId: 'job-1',
    status: 'COMPLETED',
    createdAt: '2026-04-21T00:00:00.000Z',
    updatedAt: '2026-04-21T00:00:00.000Z',
    createdBy: 'tester',
    workingDir: '/tmp',
    pipeline: { agents: {}, steps: [] } as PipelineDefinition,
    variables,
  };
}

const validJson = JSON.stringify({
  plan: {
    name: 'pong-classic',
    description: 'Browser-based Atari Pong — two paddles, ball, score.',
    epics: [
      {
        id: 'E1',
        title: 'Foundation',
        goal: 'Scaffold the project and define core types.',
        acceptanceCriteria: 'Builds cleanly',
        dependsOn: [],
        stories: [
          {
            id: 'S1',
            title: 'Scaffold project',
            description: 'Create Vite+React+TS app, install deps.',
            dependsOn: [],
            criteria: [{ id: 'AC-S1-1', text: 'npm run build exits 0', needsBrowser: false }],
          },
        ],
      },
      {
        id: 'E2',
        title: 'Game Loop',
        goal: 'Implement the render loop and physics.',
        acceptanceCriteria: 'Ball moves smoothly',
        dependsOn: ['E1'],
        stories: [
          {
            id: 'S1',
            title: 'useGameLoop hook',
            description: 'requestAnimationFrame-based loop.',
            dependsOn: [],
            criteria: [{ id: 'AC-1', text: 'Loop runs at 60fps', needsBrowser: true }],
          },
          {
            id: 'S2',
            title: 'Physics',
            description: 'Ball-paddle collision detection.',
            dependsOn: ['S1'],
            criteria: [{ id: 'AC-1', text: 'Ball bounces correctly', needsBrowser: true }],
          },
        ],
      },
    ],
  },
});

describe('planOutputSchema', () => {
  it('accepts the valid example', () => {
    const parsed = planOutputSchema.safeParse(JSON.parse(validJson));
    expect(parsed.success).toBe(true);
  });

  it('rejects when plan has zero epics', () => {
    const bad = { plan: { name: 'app', description: 'a long description here', epics: [] } };
    expect(planOutputSchema.safeParse(bad).success).toBe(false);
  });

  it('rejects when an epic has zero stories', () => {
    const bad = {
      plan: {
        name: 'app',
        description: 'a long description here',
        epics: [{ id: 'E1', title: 'Foo', goal: 'a reasonable goal text', dependsOn: [], stories: [] }],
      },
    };
    expect(planOutputSchema.safeParse(bad).success).toBe(false);
  });

  it('rejects invalid kebab-case name', () => {
    const bad = JSON.parse(validJson);
    bad.plan.name = 'PONG_Classic';
    expect(planOutputSchema.safeParse(bad).success).toBe(false);
  });
});

describe('validatePlanReferences', () => {
  it('accepts valid forward references', () => {
    const data = planOutputSchema.parse(JSON.parse(validJson));
    expect(validatePlanReferences(data)).toEqual([]);
  });

  it('rejects epic dep pointing at a later epic', () => {
    const bad = JSON.parse(validJson);
    bad.plan.epics[0].dependsOn = ['E2']; // E1 can't depend on E2
    const data = planOutputSchema.parse(bad);
    const errors = validatePlanReferences(data);
    expect(errors[0]).toMatch(/E1 depends on E2/);
  });

  it('rejects story dep that is not an earlier story in the same epic', () => {
    const bad = JSON.parse(validJson);
    bad.plan.epics[1].stories[0].dependsOn = ['S2']; // S1 can't depend on S2
    const data = planOutputSchema.parse(bad);
    const errors = validatePlanReferences(data);
    expect(errors[0]).toMatch(/Story S1.*depends on S2/);
  });

  it('rejects duplicate epic IDs', () => {
    const bad = JSON.parse(validJson);
    bad.plan.epics[1].id = 'E1';
    const data = planOutputSchema.parse(bad);
    const errors = validatePlanReferences(data);
    expect(errors.some((e) => e.includes('Duplicate epic id E1'))).toBe(true);
  });
});

describe('parsePlanOutput', () => {
  it('extracts + validates PLAN_JSON from job variables', () => {
    const job = baseJob({ PLAN_JSON: validJson });
    const output = parsePlanOutput(job);
    expect(output.plan.name).toBe('pong-classic');
    expect(output.plan.epics).toHaveLength(2);
  });

  it('throws when PLAN_JSON is missing', () => {
    const job = baseJob({});
    expect(() => parsePlanOutput(job)).toThrow(/no PLAN_JSON/);
  });

  it('throws on invalid JSON', () => {
    const job = baseJob({ PLAN_JSON: 'not json' });
    expect(() => parsePlanOutput(job)).toThrow(/not valid JSON/);
  });

  it('throws on schema violation', () => {
    const job = baseJob({ PLAN_JSON: JSON.stringify({ plan: { name: 'ok', description: 'd', epics: [] } }) });
    expect(() => parsePlanOutput(job)).toThrow(/fails schema/);
  });

  it('throws on reference errors even if schema passes', () => {
    const bad = JSON.parse(validJson);
    bad.plan.epics[0].dependsOn = ['E2'];
    const job = baseJob({ PLAN_JSON: JSON.stringify(bad) });
    expect(() => parsePlanOutput(job)).toThrow(/reference errors/);
  });
});

describe('applyPlanOutput', () => {
  it('creates epics + updates plan rollup', async () => {
    const plan = basePlan();
    const output = planOutputSchema.parse(JSON.parse(validJson));
    const createdEpics: unknown[] = [];
    const planPatches: Array<[string, Partial<Plan>]> = [];

    let uuidCounter = 0;
    const result = await applyPlanOutput(plan, output, {
      createEpic: vi.fn(async (e) => {
        createdEpics.push(e);
        return e;
      }),
      updatePlanFields: vi.fn(async (id, patch) => {
        planPatches.push([id, patch]);
      }),
      uuid: () => `uuid-${++uuidCounter}`,
      now: () => '2026-04-21T11:00:00.000Z',
    });

    expect(createdEpics).toHaveLength(2);
    expect(result.epics[0].planId).toBe('plan-1');
    expect(result.epics[0].dependsOnEpics).toEqual([]);
    // E2 depends on E1 — resolved to E1's UUID
    const e1Id = result.epics[0].epicId;
    expect(result.epics[1].dependsOnEpics).toEqual([e1Id]);
    // S2 in E2 depends on S1 — resolved UUIDs
    const e2 = result.epics[1];
    const s1Id = e2.stories[0].storyId;
    expect(e2.stories[1].dependsOn).toEqual([s1Id]);

    // Waves populated — S1 (no deps) is wave 0, S2 (depends on S1) is wave 1.
    expect(e2.stories[0].wave).toBe(0);
    expect(e2.stories[1].wave).toBe(1);
    // Epic-level waves: E1 is plan-wave 0, E2 (depends on E1) is plan-wave 1.
    expect(result.epics[0].epicWave).toBe(0);
    expect(result.epics[1].epicWave).toBe(1);

    expect(result.plan.epicIds).toHaveLength(2);
    expect(result.plan.totalStories).toBe(3); // 1 + 2
    expect(result.plan.description).toContain('Browser-based Atari Pong');

    // Verify the plan-level updatePlanFields was called with the rollup
    expect(planPatches).toHaveLength(1);
    expect(planPatches[0][1]).toMatchObject({ totalStories: 3, doneStories: 0 });
  });
});
