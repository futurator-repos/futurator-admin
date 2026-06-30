import { describe, it, expect } from 'vitest';
import { convertPlanToPlanSpec } from '../legacy-plan-to-plan-spec';
import { planSpecSchema } from '../../schemas/plan-spec-schema';
import type { Plan } from '../../types/plan';
import type { EpicWorkflow } from '../../types/epic-workflow';

const plan = (over: Partial<Plan> = {}): Plan =>
  ({
    planId: 'p1',
    appId: 'app1',
    name: 'brick-breaker',
    workingDir: '/w',
    epicIds: ['E1'],
    rigor: 'mvp',
    ...(over as object),
  }) as Plan;

const epic = (stories: unknown[]): EpicWorkflow =>
  ({
    epicId: 'E1',
    title: 'Core',
    stories,
  }) as unknown as EpicWorkflow;

describe('convertPlanToPlanSpec', () => {
  it('produces a schema-valid plan_spec from epics/stories', () => {
    const spec = convertPlanToPlanSpec(
      plan(),
      [
        epic([
          {
            storyId: 's1',
            title: 'Login',
            touchPoints: ['src/auth/**'],
            dependsOn: [],
            criteria: [{ id: 'a1', text: 'login works ok' }],
          },
          {
            storyId: 's2',
            title: 'Profile',
            touchPoints: ['src/profile/**'],
            dependsOn: ['s1'],
            criteria: [{ id: 'a2', text: 'profile shows name' }],
          },
        ]),
      ],
      'T',
    );
    expect(planSpecSchema.safeParse(spec).success).toBe(true);
    expect(spec.stories).toHaveLength(2);
    expect(spec.stories[1].depends_on).toEqual(['s1']);
    expect(spec.stories[0].acceptanceCriteria[0].testBinding.status).toBe('unbound');
  });

  it('uses EPIC_WIDE sentinel when a story declares no touchPoints', () => {
    const spec = convertPlanToPlanSpec(
      plan(),
      [epic([{ storyId: 's1', title: 'X', criteria: [{ id: 'a', text: 'does a thing' }] }])],
      'T',
    );
    expect(spec.stories[0].touches).toEqual(['<EPIC_WIDE>']);
  });

  it('synthesizes an AC when a story has none (schema needs ≥1)', () => {
    const spec = convertPlanToPlanSpec(
      plan(),
      [epic([{ storyId: 's1', title: 'No criteria story' }])],
      'T',
    );
    expect(spec.stories[0].acceptanceCriteria).toHaveLength(1);
    expect(planSpecSchema.safeParse(spec).success).toBe(true);
  });

  it('drops stale depends_on so the spec never dangling-rejects', () => {
    const spec = convertPlanToPlanSpec(
      plan(),
      [
        epic([
          {
            storyId: 's1',
            title: 'Story One',
            dependsOn: ['ghost', 's1'],
            criteria: [{ id: 'a', text: 'x y z thing' }],
          },
        ]),
      ],
      'T',
    );
    expect(spec.stories[0].depends_on).toEqual([]); // ghost dropped, self-dep dropped
    expect(planSpecSchema.safeParse(spec).success).toBe(true);
  });

  it('excludes skipped stories; derives advisory-taste for appearance ACs', () => {
    const spec = convertPlanToPlanSpec(
      plan(),
      [
        epic([
          {
            storyId: 's1',
            title: 'Keep',
            criteria: [{ id: 'a', text: 'looks right', verify: 'appearance' }],
          },
          {
            storyId: 's2',
            title: 'Drop',
            status: 'skipped',
            criteria: [{ id: 'b', text: 'whatever here' }],
          },
        ]),
      ],
      'T',
    );
    expect(spec.stories.map((s) => s.storyId)).toEqual(['s1']);
    expect(spec.stories[0].acceptanceCriteria[0].acClass).toBe('advisory-taste');
  });
});
