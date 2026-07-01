import { describe, it, expect } from 'vitest';
import { readyFrontier, depSatisfies } from '../story-graph.mjs';

// A → B (B depends on A). We vary A's state and the frontier mode.
const graph = (aState) => [
  { storyId: 'A', depends_on: [], state: aState },
  { storyId: 'B', depends_on: ['A'], state: 'blocked' },
];

describe('readyFrontier — default (kahn) is unchanged', () => {
  it('single-arg call: B unblocks only when A is done', () => {
    expect(readyFrontier(graph('developing'))).toEqual([]);
    expect(readyFrontier(graph('verifying'))).toEqual([]);
    expect(readyFrontier(graph('done'))).toEqual(['B']);
  });

  it('explicit kahn matches single-arg', () => {
    for (const st of ['claimed', 'developing', 'merging', 'verifying', 'done']) {
      expect(readyFrontier(graph(st), { mode: 'kahn' })).toEqual(readyFrontier(graph(st)));
    }
  });

  it('a root ready story is always dispatchable', () => {
    expect(readyFrontier([{ storyId: 'A', depends_on: [], state: 'ready' }])).toEqual(['A']);
  });
});

describe('readyFrontier — contract mode (§6, earn-time)', () => {
  it('B unblocks once A is integrated/committed (merging)', () => {
    expect(readyFrontier(graph('developing'), { mode: 'contract' })).toEqual([]);
    expect(readyFrontier(graph('merging'), { mode: 'contract' })).toEqual(['B']);
    expect(readyFrontier(graph('verifying'), { mode: 'contract' })).toEqual(['B']);
    expect(readyFrontier(graph('done'), { mode: 'contract' })).toEqual(['B']);
  });
});

describe('readyFrontier — green mode', () => {
  it('B unblocks once A reaches verifying (tests green), not merely merging', () => {
    expect(readyFrontier(graph('merging'), { mode: 'green' })).toEqual([]);
    expect(readyFrontier(graph('verifying'), { mode: 'green' })).toEqual(['B']);
    expect(readyFrontier(graph('done'), { mode: 'green' })).toEqual(['B']);
  });
});

describe('depSatisfies', () => {
  it('failed never satisfies, in any mode', () => {
    for (const mode of ['kahn', 'contract', 'green']) {
      expect(depSatisfies({ state: 'failed' }, mode)).toBe(false);
    }
  });
  it('unknown mode falls back to kahn (done only)', () => {
    expect(depSatisfies({ state: 'merging' }, 'nonsense')).toBe(false);
    expect(depSatisfies({ state: 'done' }, 'nonsense')).toBe(true);
  });
});
