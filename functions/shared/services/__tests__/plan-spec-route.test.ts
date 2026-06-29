import { describe, it, expect } from 'vitest';
import { handlePlanSpecIngest } from '../plan-spec-route';
import { PLAN_SPEC_SCHEMA_VERSION } from '../../schemas/plan-spec-schema';
import type { StoryNodeRow } from '../../types/plan-spec';

const repo = () => {
  const puts: StoryNodeRow[][] = [];
  return {
    puts,
    repo: {
      async batchPutStoryNodes(r: StoryNodeRow[]) {
        puts.push(r);
      },
    },
  };
};

const validSpec = (over: Record<string, unknown> = {}) => ({
  schemaVersion: PLAN_SPEC_SCHEMA_VERSION,
  planId: 'plan-1',
  appId: 'app-1',
  planSlug: 'slug',
  rigor: 'mvp',
  convergedAt: '2026-06-30T00:00:00Z',
  myceliumPlanSpecId: 'ms-1',
  stories: [
    {
      storyId: 'a',
      cohort: { epicId: 'E1' },
      title: 'Story a',
      acceptanceCriteria: [{ id: 'a1', text: 'does a thing' }],
      depends_on: [],
      touches: ['src/**'],
      complexity: 'standard',
    },
  ],
  ...over,
});

describe('handlePlanSpecIngest', () => {
  it('200 + summary on a valid spec', async () => {
    const { repo: r, puts } = repo();
    const res = await handlePlanSpecIngest({ planId: 'plan-1', body: validSpec(), repo: r });
    expect(res.status).toBe(200);
    expect(res.json.ok).toBe(true);
    expect(res.json.summary).toMatchObject({ stories: 1, ready: 1 });
    expect(puts).toHaveLength(1);
  });

  it('422 + errors when the contract is rejected (cycle), nothing written', async () => {
    const { repo: r, puts } = repo();
    const res = await handlePlanSpecIngest({
      planId: 'plan-1',
      body: validSpec({
        stories: [
          {
            storyId: 'a',
            cohort: { epicId: 'E1' },
            title: 'Story A',
            acceptanceCriteria: [{ id: 'a1', text: 'x y z thing' }],
            depends_on: ['b'],
            touches: ['s/**'],
            complexity: 'standard',
          },
          {
            storyId: 'b',
            cohort: { epicId: 'E1' },
            title: 'Story B',
            acceptanceCriteria: [{ id: 'b1', text: 'x y z thing' }],
            depends_on: ['a'],
            touches: ['s/**'],
            complexity: 'standard',
          },
        ],
      }),
      repo: r,
    });
    expect(res.status).toBe(422);
    expect(res.json.errors!.join()).toMatch(/cycle/);
    expect(puts).toHaveLength(0);
  });

  it('400 on planId mismatch between route and body', async () => {
    const res = await handlePlanSpecIngest({
      planId: 'other',
      body: validSpec(),
      repo: repo().repo,
    });
    expect(res.status).toBe(400);
    expect(res.json.errors!.join()).toMatch(/mismatch/);
  });
});
