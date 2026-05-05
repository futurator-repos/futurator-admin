import { describe, it, expect } from 'vitest';
import {
  classifyVisualTest,
  aggregateVisualTests,
  parseVisualTestViewport,
  formatViewport,
  isVagueExpect,
} from '../visual-test-classifier';
import type { VisualTestDef } from '../../types/epic-workflow';

function vt(id: string, overrides: Partial<VisualTestDef> = {}): VisualTestDef {
  return {
    id,
    criteriaRef: 'AC-1',
    description: `Test ${id}`,
    setup: 'Navigate to /',
    expect: 'something specific that can be verified by reading the screen',
    ...overrides,
  };
}

describe('parseVisualTestViewport', () => {
  it('accepts WIDTH,HEIGHT', () => {
    expect(parseVisualTestViewport('1280,720')).toEqual({ width: 1280, height: 720 });
    expect(parseVisualTestViewport('375,667')).toEqual({ width: 375, height: 667 });
    expect(parseVisualTestViewport('1280, 720')).toEqual({ width: 1280, height: 720 });
  });

  it('returns fallback when raw is undefined or empty', () => {
    expect(parseVisualTestViewport(undefined)).toEqual({ width: 1280, height: 720 });
    expect(parseVisualTestViewport(undefined, { width: 800, height: 600 })).toEqual({
      width: 800,
      height: 600,
    });
  });

  it('rejects legacy WxH form with a clear error', () => {
    expect(() => parseVisualTestViewport('1280x720')).toThrow(/legacy WxH form/);
    expect(() => parseVisualTestViewport('800x600')).toThrow(/WIDTH,HEIGHT/);
  });

  it('rejects malformed input', () => {
    expect(() => parseVisualTestViewport('not-a-viewport')).toThrow(/not WIDTH,HEIGHT/);
    expect(() => parseVisualTestViewport('1280,')).toThrow(/not WIDTH,HEIGHT/);
  });

  it('rejects out-of-range dimensions', () => {
    expect(() => parseVisualTestViewport('50,50')).toThrow(/out of plausible range/);
    expect(() => parseVisualTestViewport('99999,720')).toThrow(/out of plausible range/);
  });

  it('round-trips via formatViewport', () => {
    const dims = parseVisualTestViewport('1920,1080');
    expect(formatViewport(dims.width, dims.height)).toBe('1920,1080');
  });
});

describe('isVagueExpect', () => {
  it('flags common vague phrases', () => {
    expect(isVagueExpect('renders correctly')).toBe(true);
    expect(isVagueExpect('looks fine')).toBe(true);
    expect(isVagueExpect('looks good')).toBe(true);
    expect(isVagueExpect('works as expected')).toBe(true);
    expect(isVagueExpect('displays properly')).toBe(true);
  });

  it('flags too-short expect', () => {
    expect(isVagueExpect('')).toBe(true);
    expect(isVagueExpect('short')).toBe(true);
  });

  it('passes specific assertions', () => {
    expect(isVagueExpect('dino sprite at canvas position (50, 200) in idle frame')).toBe(false);
    expect(isVagueExpect('Score increments by 1 every second of survival')).toBe(false);
    expect(isVagueExpect('dino sprite is visible at the top-left corner of the canvas')).toBe(
      false,
    );
  });

  it('treats "is visible" as vague unless qualified', () => {
    expect(isVagueExpect('button is visible')).toBe(true);
    expect(isVagueExpect('button is visible in the header')).toBe(false);
  });
});

describe('classifyVisualTest — fixture-driven (reviewer §16.1)', () => {
  it('honors level if already set', () => {
    const result = classifyVisualTest(vt('vt-1', { level: 'L2' }));
    expect(result).toMatchObject({ level: 'L2', alreadyLeveled: true });
  });

  it('classifies multi-step flow as L2', () => {
    const t = vt('vt-flow', {
      flow: [
        { action: 'navigate', url: '/' },
        { action: 'click', selector: '#start' },
        { action: 'screenshot', label: 'after-click' },
      ],
      expect: 'clicking Start transitions menu to game-active state',
    });
    expect(classifyVisualTest(t).level).toBe('L2');
  });

  it('classifies single screenshot + selector + concrete expect as L1', () => {
    const t = vt('vt-screenshot', {
      screenshot: { selector: '#game-canvas', waitFor: 'networkidle' },
      expect: 'dino sprite renders at canvas position (50, 200) in idle frame',
    });
    expect(classifyVisualTest(t).level).toBe('L1');
  });

  it('classifies single-step flow + concrete expect as L1', () => {
    const t = vt('vt-1step', {
      flow: [{ action: 'screenshot', label: 'init' }],
      expect: 'menu shows Start button at center of canvas',
    });
    expect(classifyVisualTest(t).level).toBe('L1');
  });

  it('defaults selector + vague expect down to L0', () => {
    const t = vt('vt-vague-l1', {
      screenshot: { selector: '#root' },
      expect: 'looks fine',
    });
    expect(classifyVisualTest(t).level).toBe('L0');
  });

  it('classifies URL + expectText only as L0', () => {
    const t = vt('vt-l0-url', {
      url: '/',
      expectText: ['dino', 'Start'],
      expect: 'page contains the words "dino" and "Start"',
    });
    expect(classifyVisualTest(t).level).toBe('L0');
  });

  it('falls back to L0 with vague-expect reason', () => {
    const t = vt('vt-fallback', {
      url: '/',
      expect: 'works correctly',
    });
    const result = classifyVisualTest(t);
    expect(result.level).toBe('L0');
    expect(result.reason).toMatch(/vague expect/);
  });

  it('falls back to L0 with smoke-check reason for minimal tests', () => {
    const t = vt('vt-minimal', {
      url: '/',
      expect: 'page returns 200 with no console errors during initial load',
    });
    const result = classifyVisualTest(t);
    expect(result.level).toBe('L0');
    expect(result.reason).toMatch(/smoke check/);
  });

  // Reviewer addendum §16.12 — "no L0-level escalation if server boot fails"
  // is handled at qa-prepare time, NOT at classifier time. The classifier
  // only assigns levels; the cross-test ordering rule is enforced by the
  // pipeline orchestration layer.
});

describe('classifyVisualTest — rigor floor (PR-8f #2)', () => {
  it('floors L2 to L0 at prototype rigor', () => {
    const t = vt('vt-flow', {
      flow: [
        { action: 'navigate', url: '/' },
        { action: 'click', selector: '#start' },
        { action: 'screenshot', label: 'after' },
      ],
      expect: 'clicking Start transitions menu to game-active state',
    });
    const result = classifyVisualTest(t, 'prototype');
    expect(result.level).toBe('L0');
    expect(result.rigorFloored).toBe(true);
    expect(result.reason).toMatch(/forced L0 by prototype rigor/);
  });

  it('floors L1 to L0 at prototype rigor', () => {
    const t = vt('vt-shot', {
      screenshot: { selector: '#root' },
      expect: 'specific element shown at correct position with concrete details',
    });
    const result = classifyVisualTest(t, 'prototype');
    expect(result.level).toBe('L0');
    expect(result.rigorFloored).toBe(true);
  });

  it('floors L2 to L1 at mvp rigor', () => {
    const t = vt('vt-flow', {
      flow: [
        { action: 'navigate', url: '/' },
        { action: 'click', selector: '#start' },
        { action: 'screenshot', label: 'after' },
      ],
      expect: 'clicking Start transitions menu to game-active state',
    });
    const result = classifyVisualTest(t, 'mvp');
    expect(result.level).toBe('L1');
    expect(result.rigorFloored).toBe(true);
  });

  it('keeps L1 at mvp rigor (no floor needed)', () => {
    const t = vt('vt-shot', {
      screenshot: { selector: '#root' },
      expect: 'specific element shown at correct position with concrete details',
    });
    const result = classifyVisualTest(t, 'mvp');
    expect(result.level).toBe('L1');
    expect(result.rigorFloored).toBeUndefined();
  });

  it('allows L2 at production rigor', () => {
    const t = vt('vt-flow', {
      flow: [
        { action: 'navigate', url: '/' },
        { action: 'click', selector: '#start' },
        { action: 'screenshot', label: 'after' },
      ],
      expect: 'clicking Start transitions menu to game-active state',
    });
    const result = classifyVisualTest(t, 'production');
    expect(result.level).toBe('L2');
    expect(result.rigorFloored).toBeUndefined();
  });

  it('floors operator-set L2 at prototype rigor (rigor wins over source intent)', () => {
    const t = vt('vt-explicit-l2', {
      level: 'L2',
      flow: [{ action: 'navigate', url: '/' }],
      expect: 'something specific that can be checked',
    });
    const result = classifyVisualTest(t, 'prototype');
    expect(result.level).toBe('L0');
    expect(result.rigorFloored).toBe(true);
  });

  it('omits rigor parameter → no flooring', () => {
    const t = vt('vt-flow', {
      flow: [
        { action: 'navigate', url: '/' },
        { action: 'click', selector: '#start' },
        { action: 'screenshot', label: 'after' },
      ],
      expect: 'clicking Start transitions menu to game-active state',
    });
    const result = classifyVisualTest(t);
    expect(result.level).toBe('L2');
    expect(result.rigorFloored).toBeUndefined();
  });
});

describe('aggregateVisualTests — rigor flow-through (PR-8f #2)', () => {
  it('caps every classification at prototype', () => {
    const tests = [
      vt('l2-test', {
        flow: [
          { action: 'navigate', url: '/' },
          { action: 'click', selector: '#go' },
          { action: 'screenshot', label: 'after' },
        ],
        expect: 'navigation works after click and shows next page',
      }),
      vt('l1-test', {
        screenshot: { selector: '#a' },
        expect: 'specific element shown at correct position concretely',
      }),
      vt('l0-test', {
        url: '/',
        expectText: ['hello'],
        expect: 'page contains hello somewhere visible',
      }),
    ];
    const report = aggregateVisualTests(tests, [], 'prototype');
    expect(report.byLevel).toEqual({ L0: 3, L1: 0, L2: 0 });
    // Cost projection collapses to L0 ($0).
    expect(report.estimatedCostUsd).toBe(0);
  });

  it('caps at mvp — L1 + L0 only', () => {
    const tests = [
      vt('l2-test', {
        flow: [
          { action: 'navigate', url: '/' },
          { action: 'click', selector: '#go' },
          { action: 'screenshot', label: 'after' },
        ],
        expect: 'navigation works after click and shows next page',
      }),
      vt('l1-test', {
        screenshot: { selector: '#a' },
        expect: 'specific element shown at correct position concretely',
      }),
    ];
    const report = aggregateVisualTests(tests, [], 'mvp');
    expect(report.byLevel).toEqual({ L0: 0, L1: 2, L2: 0 });
  });

  it('production — full classification preserved', () => {
    const tests = [
      vt('l2', {
        flow: [
          { action: 'navigate', url: '/' },
          { action: 'click', selector: '#go' },
          { action: 'screenshot', label: 'after' },
        ],
        expect: 'navigation works after click and shows next page',
      }),
      vt('l1', {
        screenshot: { selector: '#a' },
        expect: 'specific element shown at correct position concretely',
      }),
      vt('l0', {
        url: '/',
        expectText: ['hi'],
        expect: 'page contains hi somewhere',
      }),
    ];
    const report = aggregateVisualTests(tests, [], 'production');
    expect(report.byLevel).toEqual({ L0: 1, L1: 1, L2: 1 });
  });
});

describe('aggregateVisualTests — coverage + specificity rollup', () => {
  it('warns about needsBrowser ACs with zero tests', () => {
    const tests = [vt('vt-1', { criteriaRef: 'AC-1', level: 'L0' })];
    const acs = [
      { id: 'AC-1', needsBrowser: true },
      { id: 'AC-2', needsBrowser: true }, // no test
      { id: 'AC-3', needsBrowser: false }, // no test, but doesn't warn
    ];
    const report = aggregateVisualTests(tests, acs);
    const warns = report.coverageWarnings.filter((w) => w.kind === 'no-tests-for-needs-browser');
    expect(warns).toHaveLength(1);
    expect(warns[0].criterionId).toBe('AC-2');
  });

  it('warns about over-tested ACs (>4 tests)', () => {
    const tests = [
      vt('vt-1', { criteriaRef: 'AC-1', level: 'L0' }),
      vt('vt-2', { criteriaRef: 'AC-1', level: 'L0' }),
      vt('vt-3', { criteriaRef: 'AC-1', level: 'L0' }),
      vt('vt-4', { criteriaRef: 'AC-1', level: 'L0' }),
      vt('vt-5', { criteriaRef: 'AC-1', level: 'L0' }),
    ];
    const report = aggregateVisualTests(tests, [{ id: 'AC-1', needsBrowser: true }]);
    expect(report.coverageWarnings.some((w) => w.kind === 'over-tested')).toBe(true);
  });

  it('flags tests with no criteriaRef', () => {
    const tests = [vt('vt-orphan', { criteriaRef: '', level: 'L0' })];
    const report = aggregateVisualTests(tests, []);
    expect(
      report.coverageWarnings.some((w) => w.kind === 'tests-without-criteria-ref'),
    ).toBe(true);
  });

  it('emits specificity warnings for vague expects', () => {
    const tests = [
      vt('vt-vague', { expect: 'looks fine', level: 'L0' }),
      vt('vt-good', { expect: 'dino at (50,200) in idle frame', level: 'L0' }),
    ];
    const report = aggregateVisualTests(tests, []);
    expect(report.specificityWarnings).toHaveLength(1);
    expect(report.specificityWarnings[0].testId).toBe('vt-vague');
  });

  it('estimates cost from per-level defaults', () => {
    const tests = [
      vt('l0', { url: '/', expectText: ['x'], expect: 'page contains x somewhere visible' }),
      vt('l1', {
        screenshot: { selector: '#a' },
        expect: 'specific element shown at correct position',
      }),
      vt('l2', {
        flow: [
          { action: 'navigate', url: '/' },
          { action: 'click', selector: '#go' },
          { action: 'screenshot', label: 'after' },
        ],
        expect: 'navigation works after click and shows next page',
      }),
    ];
    const report = aggregateVisualTests(tests, []);
    expect(report.byLevel).toEqual({ L0: 1, L1: 1, L2: 1 });
    // L0 $0 + L1 $0.005 + L2 $0.05 = $0.055
    expect(report.estimatedCostUsd).toBeCloseTo(0.055, 5);
  });

  it('respects per-test budget overrides for cost estimate', () => {
    const tests = [
      vt('l1-pricey', {
        screenshot: { selector: '#a' },
        expect: 'specific element shown at correct position',
        budgetCostUsd: 0.02,
      }),
    ];
    const report = aggregateVisualTests(tests, []);
    expect(report.estimatedCostUsd).toBeCloseTo(0.02, 5);
  });
});
