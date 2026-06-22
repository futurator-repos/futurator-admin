import { describe, it, expect } from 'vitest';
import {
  shouldCompactPlanGen,
  applyProactivePlanBudget,
  estimateStoryBudget,
  renderPlanCompactDirective,
  PLAN_COMPACT_DIRECTIVE,
  COMPACT_PROMPT_CHAR_THRESHOLD,
} from '../plan-budget.mjs';

describe('shouldCompactPlanGen — D4(a) proactive size gate', () => {
  it('returns false for small / invalid prompt sizes', () => {
    expect(shouldCompactPlanGen({ renderedChars: 1000 })).toBe(false);
    expect(shouldCompactPlanGen({ renderedChars: 0 })).toBe(false);
    expect(shouldCompactPlanGen({ renderedChars: -5 })).toBe(false);
    expect(shouldCompactPlanGen({ renderedChars: NaN })).toBe(false);
    expect(shouldCompactPlanGen({})).toBe(false);
  });

  it('fires when the rendered prompt crosses the threshold', () => {
    expect(shouldCompactPlanGen({ renderedChars: COMPACT_PROMPT_CHAR_THRESHOLD })).toBe(true);
    expect(shouldCompactPlanGen({ renderedChars: COMPACT_PROMPT_CHAR_THRESHOLD + 5000 })).toBe(true);
    expect(shouldCompactPlanGen({ renderedChars: COMPACT_PROMPT_CHAR_THRESHOLD - 1 })).toBe(false);
  });

  it('lowers the bar for production rigor (larger plans)', () => {
    const justUnderMvp = Math.round(COMPACT_PROMPT_CHAR_THRESHOLD * 0.85);
    // Under the mvp bar, but over the production bar (0.8×).
    expect(shouldCompactPlanGen({ renderedChars: justUnderMvp, rigor: 'mvp' })).toBe(false);
    expect(shouldCompactPlanGen({ renderedChars: justUnderMvp, rigor: 'production' })).toBe(true);
  });
});

describe('applyProactivePlanBudget — directive injection', () => {
  it('leaves a small prompt unchanged', () => {
    const small = 'plan this small intent';
    const res = applyProactivePlanBudget(small);
    expect(res.injected).toBe(false);
    expect(res.prompt).toBe(small);
  });

  it('prepends a compact directive carrying a concrete story ceiling to a large prompt', () => {
    const large = 'x'.repeat(COMPACT_PROMPT_CHAR_THRESHOLD + 100);
    const res = applyProactivePlanBudget(large, { maxOutputTokens: 32000, rigor: 'mvp' });
    expect(res.injected).toBe(true);
    expect(res.storyBudget).toBeGreaterThan(0);
    expect(res.prompt).toContain(large);
    expect(res.prompt).toContain('PROACTIVE BUDGET GUARD');
    expect(res.prompt).toContain(`AT MOST ${res.storyBudget} stories`);
    expect(res.prompt).toContain('---END_PLAN_JSON---');
  });

  it('handles empty / non-string prompts safely', () => {
    expect(applyProactivePlanBudget('').injected).toBe(false);
    expect(applyProactivePlanBudget(null).injected).toBe(false);
    expect(applyProactivePlanBudget(undefined).injected).toBe(false);
  });
});

describe('estimateStoryBudget — D4(a) cap-sized story ceiling', () => {
  it('scales the ceiling with the output cap (below the rigor soft ceiling)', () => {
    // Use caps small enough that the raw estimate is under the mvp ceiling (12),
    // so the cap-scaling is observable rather than clamped.
    const tight = estimateStoryBudget({ maxOutputTokens: 4000, rigor: 'mvp' });
    const roomy = estimateStoryBudget({ maxOutputTokens: 7000, rigor: 'mvp' });
    expect(roomy).toBeGreaterThan(tight);
  });

  it('never goes below the floor (a complex app still needs a few stories)', () => {
    expect(estimateStoryBudget({ maxOutputTokens: 2000, rigor: 'mvp' })).toBeGreaterThanOrEqual(4);
  });

  it('never exceeds the rigor soft ceiling (does not raise the in-prompt contract)', () => {
    expect(estimateStoryBudget({ maxOutputTokens: 1_000_000, rigor: 'mvp' })).toBeLessThanOrEqual(12);
    expect(estimateStoryBudget({ maxOutputTokens: 1_000_000, rigor: 'production' })).toBeLessThanOrEqual(18);
  });

  it('defaults to the CLI default cap (32000) when unset', () => {
    expect(estimateStoryBudget({})).toBe(estimateStoryBudget({ maxOutputTokens: 32000 }));
  });
});

describe('renderPlanCompactDirective', () => {
  it('embeds the concrete number and the closing-fence requirement', () => {
    const d = renderPlanCompactDirective(7);
    expect(d).toContain('AT MOST 7 stories');
    expect(d).toContain('≤ 7 stories');
    expect(d).toContain('---END_PLAN_JSON---');
  });

  it('PLAN_COMPACT_DIRECTIVE back-compat export still renders', () => {
    expect(PLAN_COMPACT_DIRECTIVE).toContain('PROACTIVE BUDGET GUARD');
  });
});
