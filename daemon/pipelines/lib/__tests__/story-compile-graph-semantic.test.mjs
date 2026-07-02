import { describe, it, expect } from 'vitest';
import { shouldRunSemantic } from '../story-compile-graph.mjs';

describe('shouldRunSemantic (P3_SEMANTIC_COMPILE gate)', () => {
  it('off (default) never fires — dark', () => {
    expect(shouldRunSemantic('off', false)).toBe(false);
    expect(shouldRunSemantic('off', true)).toBe(false);
    expect(shouldRunSemantic(undefined, true)).toBe(false);
  });

  it('on fires every story', () => {
    expect(shouldRunSemantic('on', false)).toBe(true);
    expect(shouldRunSemantic('on', true)).toBe(true);
  });

  it('cohort fires only on the cohort-close story', () => {
    expect(shouldRunSemantic('cohort', false)).toBe(false);
    expect(shouldRunSemantic('cohort', true)).toBe(true);
  });
});
