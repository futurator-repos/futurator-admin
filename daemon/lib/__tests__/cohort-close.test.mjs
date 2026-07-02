import { describe, it, expect } from 'vitest';
import { isLastInCohort } from '../story-graph.mjs';

const nodes = (states) => states.map((s, i) => ({ storyId: `S${i}`, cohortBatch: s.b, state: s.st }));

describe('isLastInCohort (cohort-close signal)', () => {
  it('true when every sibling in the batch is done', () => {
    const n = nodes([{ b: 0, st: 'done' }, { b: 0, st: 'done' }, { b: 1, st: 'ready' }]);
    expect(isLastInCohort(n, 'S0')).toBe(true); // S1 done, S2 is a different batch
  });
  it('false when a sibling in the batch is still running', () => {
    const n = nodes([{ b: 0, st: 'done' }, { b: 0, st: 'developing' }]);
    expect(isLastInCohort(n, 'S0')).toBe(false);
  });
  it('true for a solo story in its batch', () => {
    const n = nodes([{ b: 2, st: 'done' }, { b: 0, st: 'ready' }]);
    expect(isLastInCohort(n, 'S0')).toBe(true);
  });
  it('false when cohortBatch is missing (never fires the cohort lane)', () => {
    expect(isLastInCohort([{ storyId: 'S0', state: 'done' }], 'S0')).toBe(false);
  });
  it('reads storyState as a fallback for state', () => {
    const n = [
      { storyId: 'S0', cohortBatch: 0, state: 'done' },
      { storyId: 'S1', cohortBatch: 0, storyState: 'done' },
    ];
    expect(isLastInCohort(n, 'S0')).toBe(true);
  });
});
