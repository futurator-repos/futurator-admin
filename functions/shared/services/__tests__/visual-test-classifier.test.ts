import { describe, it, expect } from 'vitest';
import {
  classifyVisualTest,
  aggregateVisualTests,
  parseVisualTestViewport,
  formatViewport,
  isVagueExpect,
  deriveLevelFromVerify,
  deriveNeedsBrowser,
  downgradeManualToBehavior,
  capVisionLevelByRigor,
  isDeterministicLevel,
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
    expect(report.coverageWarnings.some((w) => w.kind === 'tests-without-criteria-ref')).toBe(true);
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

/**
 * PR-62 (2026-05-15) — needsBrowser floor.
 *
 * Browser-tagged ACs cannot be verified by L0 (bash-only checks: HTTP 200,
 * screenshot non-blank, console errors, expectText substring). spyhunter-1
 * shipped a game with no enemies because all 26 needsBrowser ACs silently
 * classified to L0 ("page rendered, screenshot > 2KB" → pass). The fix:
 * when an AC needsBrowser, the test associated with it cannot stay at L0
 * — even if the rigor ceiling is L0 (prototype).
 */
describe('classifyVisualTest — needsBrowser floor (PR-62)', () => {
  it('raises a default-L0 test to L1 when AC needsBrowser', () => {
    const t = vt('vt-1', { expect: 'something specific to verify on screen' });
    // Without needsBrowser → L0 (no flow/screenshot/expectText → smoke check)
    expect(classifyVisualTest(t).level).toBe('L0');
    // With needsBrowser → raised to L1
    const result = classifyVisualTest(t, undefined, true);
    expect(result.level).toBe('L1');
    expect(result.reason).toMatch(/needsBrowser/);
  });

  it('raises a URL+expectText L0 test to L1 when AC needsBrowser', () => {
    const t = vt('vt-2', {
      url: '/dashboard',
      expectText: ['Welcome back'],
    });
    expect(classifyVisualTest(t).level).toBe('L0');
    expect(classifyVisualTest(t, undefined, true).level).toBe('L1');
  });

  it('does NOT raise tests already at L1 or higher', () => {
    const t = vt('vt-3', {
      screenshot: { selector: '#chart' },
      expect: 'the bar chart renders with three blue bars at heights 30/60/90px',
    });
    // Shape gives L1 directly
    expect(classifyVisualTest(t).level).toBe('L1');
    // Re-classifying with needsBrowser=true stays L1 (not bumped to L2)
    expect(classifyVisualTest(t, undefined, true).level).toBe('L1');
  });

  it('does NOT raise tests when AC does not need browser (default behaviour preserved)', () => {
    const t = vt('vt-4', { expect: 'some smoke check that the page exists' });
    expect(classifyVisualTest(t).level).toBe('L0');
    expect(classifyVisualTest(t, undefined, false).level).toBe('L0');
    // Omitting the argument also keeps the old behaviour.
    expect(classifyVisualTest(t).level).toBe('L0');
  });

  it('OVERRIDES the rigor cap: prototype + needsBrowser still ships at L1', () => {
    // Prototype rigor caps at L0 normally. needsBrowser should win.
    const t = vt('vt-5', { expect: 'login button is visible and clickable' });
    expect(classifyVisualTest(t, 'prototype').level).toBe('L0');
    const result = classifyVisualTest(t, 'prototype', true);
    expect(result.level).toBe('L1');
    expect(result.reason).toMatch(/needsBrowser/);
    // rigorFloored flag is cleared when needsBrowser wins
    expect(result.rigorFloored).toBeUndefined();
  });

  it('coexists with rigor cap: needsBrowser on production-rigor L2 stays L2', () => {
    const t = vt('vt-6', {
      flow: [
        { action: 'navigate', url: '/' },
        { action: 'click', selector: '#go' },
        { action: 'screenshot', label: 'after' },
      ],
      expect: 'navigation lands on the next page',
    });
    expect(classifyVisualTest(t, 'production', true).level).toBe('L2');
  });

  it('aggregateVisualTests indexes needsBrowser by AC id and applies the floor', () => {
    const browserTest = vt('vt-7', {
      criteriaRef: 'AC-needs-browser',
      expect: 'a button renders in the corner of the form',
    });
    const nonBrowserTest = vt('vt-8', {
      criteriaRef: 'AC-internal',
      expect: 'the migration function returns a non-empty array',
    });
    const acs = [
      { id: 'AC-needs-browser', needsBrowser: true },
      { id: 'AC-internal', needsBrowser: false },
    ];
    const report = aggregateVisualTests([browserTest, nonBrowserTest], acs);
    // The browser test was L0 by shape, raised to L1 by the AC floor.
    const browserClass = report.classifications.find((c) => c.testId === 'vt-7');
    expect(browserClass?.classification.level).toBe('L1');
    expect(browserClass?.classification.reason).toMatch(/needsBrowser/);
    // The non-browser test stays at L0.
    const nonBrowserClass = report.classifications.find((c) => c.testId === 'vt-8');
    expect(nonBrowserClass?.classification.level).toBe('L0');
  });
});

/**
 * VQA v3 — Story E5.4 (R1): verify-based level derivation + the SPLIT rigor cap
 * (vision tiers only; deterministic L0/L2-state are rigor-exempt). This is the
 * highest-risk, easiest-to-miss requirement — guard it hard.
 */
describe('deriveLevelFromVerify (VQA v3 — E5.4/FR-13)', () => {
  it('build→L0, appearance→L1, manual→operator', () => {
    expect(deriveLevelFromVerify('build', false)).toBe('L0');
    expect(deriveLevelFromVerify('appearance', true)).toBe('L1');
    expect(deriveLevelFromVerify('manual', true)).toBe('operator');
  });

  it('state→L2-state with a seam, else L1-vision', () => {
    expect(deriveLevelFromVerify('state', true)).toBe('L2-state');
    expect(deriveLevelFromVerify('state', false)).toBe('L1');
  });

  it('behavior→L2-state with a seam, else L2-vision', () => {
    expect(deriveLevelFromVerify('behavior', true)).toBe('L2-state');
    expect(deriveLevelFromVerify('behavior', false)).toBe('L2-vision');
  });
});

describe('capVisionLevelByRigor — R1 split cap (VQA v3 — E5.4)', () => {
  it('AC1 — a state AC with a seam at prototype routes to L2-state, NOT capped to L0', () => {
    const level = deriveLevelFromVerify('state', true); // L2-state
    expect(capVisionLevelByRigor(level, 'prototype')).toBe('L2-state'); // deterministic = exempt
  });

  it('AC2 — an appearance (vision) AC at prototype IS still rigor-capped', () => {
    const level = deriveLevelFromVerify('appearance', true); // L1 (vision)
    expect(capVisionLevelByRigor(level, 'prototype')).toBe('L0'); // vision capped at prototype
  });

  it('caps L2-vision → L1 at mvp, leaves it at production', () => {
    expect(capVisionLevelByRigor('L2-vision', 'mvp')).toBe('L1');
    expect(capVisionLevelByRigor('L2-vision', 'production')).toBe('L2-vision');
  });

  it('L2-state and operator are exempt at every rigor', () => {
    for (const r of ['prototype', 'mvp', 'production'] as const) {
      expect(capVisionLevelByRigor('L2-state', r)).toBe('L2-state');
      expect(capVisionLevelByRigor('operator', r)).toBe('operator');
    }
  });

  it('isDeterministicLevel marks L0 + L2-state', () => {
    expect(isDeterministicLevel('L0')).toBe(true);
    expect(isDeterministicLevel('L2-state')).toBe(true);
    expect(isDeterministicLevel('L1')).toBe(false);
    expect(isDeterministicLevel('L2-vision')).toBe(false);
  });
});

describe('aggregateVisualTests — verify-aware oracle tier + strength (E4-S2/S3)', () => {
  it('resolves a behavior AC to L2-state with a seam + assert probe; no weak-oracle warning', () => {
    const tests: VisualTestDef[] = [
      vt('VT-1', {
        criteriaRef: 'AC-1',
        flow: [
          { action: 'press', key: 'Space' },
          { action: 'assert', expr: 'snapshot.status', op: 'eq', expected: 'running' },
        ],
      }),
    ];
    const report = aggregateVisualTests(
      tests,
      [{ id: 'AC-1', needsBrowser: true, verify: 'behavior' }],
      'production',
      true,
    );
    expect(report.classifications[0].classification.resolvedLevel).toBe('L2-state');
    expect(report.coverageWarnings.some((w) => w.kind === 'weak-oracle')).toBe(false);
  });

  it('flags weak-oracle when a behavior AC has a seam but only a screenshot (vision-only)', () => {
    const tests: VisualTestDef[] = [
      vt('VT-1', { criteriaRef: 'AC-1', flow: [{ action: 'screenshot', label: 'idle' }] }),
    ];
    const report = aggregateVisualTests(
      tests,
      [{ id: 'AC-1', needsBrowser: true, verify: 'behavior' }],
      'production',
      true,
    );
    expect(report.coverageWarnings.find((w) => w.kind === 'weak-oracle')?.criterionId).toBe('AC-1');
  });

  it('without a seam, a behavior AC resolves to L2-vision and is NOT weak-oracle-flagged', () => {
    const report = aggregateVisualTests(
      [vt('VT-1', { criteriaRef: 'AC-1' })],
      [{ id: 'AC-1', needsBrowser: true, verify: 'behavior' }],
      'production',
      false,
    );
    expect(report.classifications[0].classification.resolvedLevel).toBe('L2-vision');
    expect(report.coverageWarnings.some((w) => w.kind === 'weak-oracle')).toBe(false);
  });

  it('flags unpaired-l2-state when a UI-bearing behavior AC asserts state but has no paired screenshot (E5.6/H3)', () => {
    const tests: VisualTestDef[] = [
      vt('VT-1', {
        criteriaRef: 'AC-1',
        flow: [
          { action: 'press', key: 'Space' },
          { action: 'assert', expr: 'snapshot.status', op: 'eq', expected: 'running' },
        ],
      }),
    ];
    const report = aggregateVisualTests(
      tests,
      [{ id: 'AC-1', needsBrowser: true, verify: 'behavior' }],
      'production',
      true,
    );
    expect(report.coverageWarnings.find((w) => w.kind === 'unpaired-l2-state')?.criterionId).toBe(
      'AC-1',
    );
    // It has an assert, so it is NOT also weak-oracle.
    expect(report.coverageWarnings.some((w) => w.kind === 'weak-oracle')).toBe(false);
  });

  it('does NOT flag unpaired-l2-state when the L2-state probe also has a screenshot', () => {
    const tests: VisualTestDef[] = [
      vt('VT-1', {
        criteriaRef: 'AC-1',
        flow: [
          { action: 'press', key: 'Space' },
          { action: 'screenshot', label: 'after' },
          { action: 'assert', expr: 'snapshot.status', op: 'eq', expected: 'running' },
        ],
      }),
    ];
    const report = aggregateVisualTests(
      tests,
      [{ id: 'AC-1', needsBrowser: true, verify: 'behavior' }],
      'production',
      true,
    );
    expect(report.coverageWarnings.some((w) => w.kind === 'unpaired-l2-state')).toBe(false);
  });

  it('does NOT flag unpaired-l2-state for a non-UI (needsBrowser:false) state AC', () => {
    const tests: VisualTestDef[] = [
      vt('VT-1', {
        criteriaRef: 'AC-1',
        flow: [{ action: 'assert', expr: 'snapshot.score', op: 'gt', expected: 0 }],
      }),
    ];
    const report = aggregateVisualTests(
      tests,
      [{ id: 'AC-1', needsBrowser: false, verify: 'state' }],
      'production',
      true,
    );
    expect(report.coverageWarnings.some((w) => w.kind === 'unpaired-l2-state')).toBe(false);
  });

  it('downgradeManualToBehavior — stubbable manual AC downgrades to behavior + forces needsBrowser + logs event (E8.3)', () => {
    const d = downgradeManualToBehavior({
      acId: 'AC-1',
      verify: 'manual',
      manualReason: 'oauth-consent',
      stubAvailable: true,
    });
    expect(d.verify).toBe('behavior');
    expect(d.needsBrowser).toBe(true);
    expect(d.reclassified).toBe(true);
    expect(d.event?.kind).toBe('manual-downgrade');
    expect(d.event?.acId).toBe('AC-1');
  });

  it('downgradeManualToBehavior — genuinely unautomatable manual AC stays manual (no stub)', () => {
    const d = downgradeManualToBehavior({
      acId: 'AC-2',
      verify: 'manual',
      manualReason: 'real-payment',
      stubAvailable: false,
    });
    expect(d.verify).toBe('manual');
    expect(d.reclassified).toBe(false);
    expect(d.event).toBeNull();
  });

  it('downgradeManualToBehavior — non-manual AC passes through unchanged', () => {
    const d = downgradeManualToBehavior({ acId: 'AC-3', verify: 'behavior', stubAvailable: true });
    expect(d.verify).toBe('behavior');
    expect(d.reclassified).toBe(false);
    expect(d.event).toBeNull();
  });

  it('deriveNeedsBrowser — one rule: build→false, appearance/state/behavior→true, manual→undefined', () => {
    expect(deriveNeedsBrowser('build')).toBe(false);
    expect(deriveNeedsBrowser('appearance')).toBe(true);
    expect(deriveNeedsBrowser('state')).toBe(true);
    expect(deriveNeedsBrowser('behavior')).toBe(true);
    expect(deriveNeedsBrowser('manual')).toBeUndefined();
    expect(deriveNeedsBrowser(undefined)).toBeUndefined();
  });

  it('a prototype-rigor state AC with a seam still resolves to L2-state (rigor-exempt, R1)', () => {
    const report = aggregateVisualTests(
      [
        vt('VT-1', {
          criteriaRef: 'AC-1',
          flow: [{ action: 'assert', expr: 'snapshot.score', op: 'gt', expected: 0 }],
        }),
      ],
      [{ id: 'AC-1', needsBrowser: true, verify: 'state' }],
      'prototype',
      true,
    );
    expect(report.classifications[0].classification.resolvedLevel).toBe('L2-state');
  });
});
