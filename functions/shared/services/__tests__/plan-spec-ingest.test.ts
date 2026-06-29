import { describe, it, expect } from 'vitest';
import { ingestPlanSpec, type StoryNodeRepository } from '../plan-spec-ingest';
import { PLAN_SPEC_SCHEMA_VERSION } from '../../schemas/plan-spec-schema';
import type { StoryNodeRow } from '../../types/plan-spec';

function captureRepo() {
  const puts: StoryNodeRow[][] = [];
  const repo: StoryNodeRepository = {
    async batchPutStoryNodes(rows) {
      puts.push(rows);
    },
  };
  return { repo, puts };
}

const ac = (id: string) => ({ id, text: `${id} acceptance text` });
const story = (storyId: string, depends_on: string[] = [], over: Record<string, unknown> = {}) => ({
  storyId,
  cohort: { epicId: 'E1' },
  title: `Story ${storyId}`,
  acceptanceCriteria: [ac(`${storyId}-ac1`)],
  depends_on,
  touches: ['src/**'],
  complexity: 'standard',
  ...over,
});

const spec = (stories: unknown[], over: Record<string, unknown> = {}) => ({
  schemaVersion: PLAN_SPEC_SCHEMA_VERSION,
  planId: 'plan-1',
  appId: 'app-1',
  planSlug: 'slug',
  rigor: 'mvp',
  convergedAt: '2026-06-29T00:00:00Z',
  myceliumPlanSpecId: 'ms-1',
  stories,
  ...over,
});

describe('ingestPlanSpec — happy path', () => {
  it('seeds state/unblockedDepsCount/cohortBatch over a diamond', async () => {
    const { repo, puts } = captureRepo();
    // a → b,c → d
    const res = await ingestPlanSpec(
      spec([story('a'), story('b', ['a']), story('c', ['a']), story('d', ['b', 'c'])]),
      { repo, now: () => 'T' },
    );
    expect(res.ok).toBe(true);
    const rows = res.rows!;
    const byId = Object.fromEntries(rows.map((r) => [r.storyId, r]));
    expect(byId.a.state).toBe('ready');
    expect(byId.a.unblockedDepsCount).toBe(0);
    expect(byId.b.state).toBe('blocked');
    expect(byId.b.unblockedDepsCount).toBe(1);
    expect(byId.d.unblockedDepsCount).toBe(2);
    expect(byId.a.cohortBatch).toBe(0);
    expect(byId.b.cohortBatch).toBe(1);
    expect(byId.d.cohortBatch).toBe(2);
    expect(res.summary).toEqual({ stories: 4, ready: 1, blocked: 3, maxBatch: 2 });
    expect(puts).toHaveLength(1); // single batch put (atomic, not half-ingested)
  });

  it('defaults every AC testBinding to unbound and applies acClass default', async () => {
    const { repo } = captureRepo();
    const res = await ingestPlanSpec(spec([story('a')]), { repo });
    const acOut = res.rows![0].acceptanceCriteria[0] as {
      testBinding: { status: string };
      acClass: string;
    };
    expect(acOut.testBinding.status).toBe('unbound');
    expect(acOut.acClass).toBe('deterministic');
  });

  it('marks the plan developing (best-effort)', async () => {
    const { repo } = captureRepo();
    let marked = '';
    await ingestPlanSpec(spec([story('a')]), {
      repo,
      planRepo: {
        async markDeveloping(id) {
          marked = id;
        },
      },
    });
    expect(marked).toBe('plan-1');
  });
});

describe('ingestPlanSpec — rejects the whole spec', () => {
  it('rejects a dependency cycle', async () => {
    const { repo, puts } = captureRepo();
    const res = await ingestPlanSpec(spec([story('a', ['b']), story('b', ['a'])]), { repo });
    expect(res.ok).toBe(false);
    expect(res.errors!.join()).toMatch(/cycle/);
    expect(puts).toHaveLength(0);
  });
  it('rejects a dangling depends_on', async () => {
    const { repo } = captureRepo();
    const res = await ingestPlanSpec(spec([story('a', ['ghost'])]), { repo });
    expect(res.ok).toBe(false);
    expect(res.errors!.join()).toMatch(/dangling/);
  });
  it('rejects a story with empty touches', async () => {
    const { repo } = captureRepo();
    const res = await ingestPlanSpec(spec([story('a', [], { touches: [] })]), { repo });
    expect(res.ok).toBe(false);
    expect(res.errors!.join()).toMatch(/touches/);
  });
  it('rejects a duplicate storyId', async () => {
    const { repo } = captureRepo();
    const res = await ingestPlanSpec(spec([story('a'), story('a')]), { repo });
    expect(res.ok).toBe(false);
    expect(res.errors!.join()).toMatch(/duplicate/);
  });
  it('rejects a bad schemaVersion', async () => {
    const { repo } = captureRepo();
    const res = await ingestPlanSpec(spec([story('a')], { schemaVersion: 'nope' }), { repo });
    expect(res.ok).toBe(false);
  });
});
