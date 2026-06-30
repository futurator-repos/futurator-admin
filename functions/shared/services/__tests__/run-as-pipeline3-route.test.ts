import { describe, it, expect } from 'vitest';
import { handleRunAsPipeline3 } from '../run-as-pipeline3-route';
import type { Plan } from '../../types/plan';
import type { EpicWorkflow } from '../../types/epic-workflow';
import type { StoryNodeRow } from '../../types/plan-spec';

const plan = (): Plan =>
  ({
    planId: 'p1',
    appId: 'a',
    name: 'slug',
    workingDir: '/w',
    epicIds: ['E1'],
    rigor: 'mvp',
  }) as Plan;
const epic = (): EpicWorkflow =>
  ({
    epicId: 'E1',
    title: 'Core',
    stories: [
      {
        storyId: 's1',
        title: 'Login',
        touchPoints: ['src/**'],
        criteria: [{ id: 'a1', text: 'login works ok' }],
      },
    ],
  }) as unknown as EpicWorkflow;

function deps(over = {}) {
  const puts: StoryNodeRow[][] = [];
  return {
    puts,
    deps: {
      getPlanById: async () => plan(),
      getEpicById: async () => epic(),
      repo: {
        async batchPutStoryNodes(r: StoryNodeRow[]) {
          puts.push(r);
        },
      },
      now: () => 'T',
      ...over,
    },
  };
}

describe('handleRunAsPipeline3', () => {
  it('200 + ingests StoryNode rows from a legacy plan', async () => {
    const { deps: d, puts } = deps();
    const res = await handleRunAsPipeline3({ planId: 'p1', deps: d });
    expect(res.status).toBe(200);
    expect(res.json.ok).toBe(true);
    expect(res.json.stories).toBe(1);
    expect(puts).toHaveLength(1);
  });

  it('404 when the plan is missing', async () => {
    const { deps: d } = deps({ getPlanById: async () => null });
    const res = await handleRunAsPipeline3({ planId: 'nope', deps: d });
    expect(res.status).toBe(404);
  });

  it('422 when the plan has no epics', async () => {
    const { deps: d } = deps({ getEpicById: async () => null });
    const res = await handleRunAsPipeline3({ planId: 'p1', deps: d });
    expect(res.status).toBe(422);
  });
});
