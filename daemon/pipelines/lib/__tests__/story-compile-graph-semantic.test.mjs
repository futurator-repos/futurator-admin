import { describe, it, expect } from 'vitest';
import { shouldRunSemantic, resolveCompileSteps } from '../story-compile-graph.mjs';

describe('resolveCompileSteps (P3_GRAPH_GROWTH_SPLIT)', () => {
  it('off (default) → full 3-step compile', () => {
    expect(resolveCompileSteps(false, false)).toEqual(['compile-diff', 'compile-knowledge', 'compile-sync']);
  });
  it('split per-story → deterministic only (drops the LLM compile-knowledge)', () => {
    expect(resolveCompileSteps(true, false)).toEqual(['compile-diff', 'compile-sync']);
  });
  it('split cohort-close → runs the LLM article lane too', () => {
    expect(resolveCompileSteps(true, true)).toEqual(['compile-diff', 'compile-knowledge', 'compile-sync']);
  });
});

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
