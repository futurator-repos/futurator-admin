import { describe, it, expect } from 'vitest';
import { convertPlanToPlanSpec, deriveStoryDependencies } from '../legacy-plan-to-plan-spec';
import { planSpecSchema } from '../../schemas/plan-spec-schema';
import type { Plan } from '../../types/plan';
import type { EpicWorkflow } from '../../types/epic-workflow';
import type { StoryNode } from '../../types/plan-spec';

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

// ── deriveStoryDependencies — batching for legacy plans with no deps ──────────

const node = (over: Partial<StoryNode> & { storyId: string }): StoryNode =>
  ({
    cohort: { epicId: 'E1' },
    title: over.storyId,
    intent: '',
    acceptanceCriteria: [],
    depends_on: [],
    touches: [],
    forbiddenAreas: [],
    complexity: 'standard',
    ...over,
  }) as StoryNode;

describe('deriveStoryDependencies', () => {
  it('stages foundation → feature → integration when the plan is flat', () => {
    const stories = [
      node({
        storyId: 'found',
        title: 'Define game types and constants',
        touches: ['src/types.ts'],
      }),
      node({ storyId: 'feat-a', title: 'Implement dino entity', touches: ['src/dino.ts'] }),
      node({
        storyId: 'feat-b',
        title: 'Implement obstacle system',
        touches: ['src/obstacles.ts'],
      }),
      node({ storyId: 'integ', title: 'Assemble the complete game', touches: ['src/game.tsx'] }),
    ];
    deriveStoryDependencies(stories);

    const by = Object.fromEntries(stories.map((s) => [s.storyId, s.depends_on]));
    expect(by['found']).toEqual([]); // foundation is batch 0
    expect(by['feat-a']).toEqual(['found']); // features depend on foundation
    expect(by['feat-b']).toEqual(['found']);
    expect(by['integ'].sort()).toEqual(['feat-a', 'feat-b', 'found']); // integration last
  });

  it('serializes same-layer siblings that write the same concrete file', () => {
    const stories = [
      node({ storyId: 'a', title: 'Implement thing A', touches: ['src/shared.ts'] }),
      node({ storyId: 'b', title: 'Implement thing B', touches: ['src/shared.ts', 'src/b.ts'] }),
    ];
    deriveStoryDependencies(stories);
    expect(stories[0].depends_on).toEqual([]);
    expect(stories[1].depends_on).toEqual(['a']); // b waits for a (shared src/shared.ts)
  });

  it('treats an EPIC_WIDE story as integration (depends on everything before)', () => {
    const stories = [
      node({ storyId: 'found', title: 'Setup config', touches: ['config.ts'] }),
      node({ storyId: 'feat', title: 'Implement widget', touches: ['w.ts'] }),
      node({ storyId: 'wide', title: 'Final wiring', touches: ['<EPIC_WIDE>'] }),
    ];
    deriveStoryDependencies(stories);
    expect(stories[2].depends_on.sort()).toEqual(['feat', 'found']);
  });

  it('is a no-op when any story already declares depends_on', () => {
    const stories = [
      node({ storyId: 'a', title: 'Define types' }),
      node({ storyId: 'b', title: 'Implement feature', depends_on: ['a'] }),
    ];
    const added = deriveStoryDependencies(stories);
    expect(added).toBe(0);
    expect(stories[0].depends_on).toEqual([]); // not rewritten
  });

  it('convertPlanToPlanSpec yields a schema-valid multi-batch spec from a flat plan', () => {
    const spec = convertPlanToPlanSpec(
      plan(),
      [
        epic([
          {
            storyId: 's-types',
            title: 'Define types and constants',
            touchPoints: ['src/types.ts'],
            criteria: [{ id: 'a', text: 'types compile ok' }],
          },
          {
            storyId: 's-feat1',
            title: 'Implement entity',
            touchPoints: ['src/entity.ts'],
            criteria: [{ id: 'b', text: 'entity moves ok' }],
          },
          {
            storyId: 's-feat2',
            title: 'Implement scoring',
            touchPoints: ['src/score.ts'],
            criteria: [{ id: 'c', text: 'score increments ok' }],
          },
          {
            storyId: 's-assemble',
            title: 'Assemble the complete app',
            touchPoints: ['src/app.tsx'],
            criteria: [{ id: 'd', text: 'app renders ok' }],
          },
        ]),
      ],
      'T',
    );
    expect(planSpecSchema.safeParse(spec).success).toBe(true);
    // Three distinct dependency depths → the frontier will stage ≥3 batches.
    const depth = (id: string): number => {
      const s = spec.stories.find((x) => x.storyId === id)!;
      return s.depends_on.length === 0 ? 0 : 1 + Math.max(...s.depends_on.map(depth));
    };
    expect(depth('s-types')).toBe(0);
    expect(depth('s-feat1')).toBe(1);
    expect(depth('s-assemble')).toBe(2);
  });
});
