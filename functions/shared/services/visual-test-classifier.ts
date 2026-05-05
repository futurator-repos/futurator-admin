/**
 * Pipeline v2.0 PR-8 — visual-test classifier + viewport parser.
 *
 * Pure functions. No I/O, no model calls. Used by:
 *   • qa-aggregate (bash-side step) — auto-classifies tests missing `level`
 *     and drops a JSON sidecar the operator review UI consumes.
 *   • The contract-approval API endpoint — final classification check
 *     before promoting visual-tests-draft.md → visual-tests-approved.md.
 *
 * Why a JS function and not bash regex inside qa-aggregate: classification
 * needs to be testable against fixtures. Reviewer addendum §16.1 calls for
 * a fixture-driven test suite; impossible if the classifier is bash heredoc.
 * The qa-aggregate shell step shells out to `node` which calls into this.
 */

import type {
  VisualTestDef,
  VisualTestLevel,
} from '../types/epic-workflow';
import type { PlanRigor } from '../types/plan';

// ── Viewport parser (Q2.2) ────────────────────────────────────────────

/**
 * Pipeline v2.0 PR-8 (Q2.2) — schema-fixed viewport.
 *
 * Accepts ONLY `WIDTH,HEIGHT` (commas). Rejects the historical `1280x720`
 * form because that's the bug class that masked Problem #5: the LLM kept
 * emitting `--viewport-size=1280x720` (Playwright wants commas) and runs
 * silently fell back to the default 1280×720 viewport, producing
 * misleadingly-correct screenshots for tests that should have run at
 * `375,667` (mobile) or `1920,1080` (desktop-wide).
 *
 * Returns the parsed dimensions, or throws — callers must validate at
 * parse time, not at QA execution time.
 */
export function parseVisualTestViewport(
  raw: string | undefined,
  fallback = { width: 1280, height: 720 },
): { width: number; height: number } {
  if (!raw) return fallback;
  const trimmed = raw.trim();
  // Reject the legacy 'x' form explicitly so the failure mode is loud.
  if (/^\d+\s*x\s*\d+$/i.test(trimmed)) {
    throw new Error(
      `viewport "${raw}" uses the legacy WxH form; PR-8 requires WIDTH,HEIGHT (commas) so the playwright --viewport-size flag is correct. Use e.g. "1280,720".`,
    );
  }
  const m = /^(\d{2,5})\s*,\s*(\d{2,5})$/.exec(trimmed);
  if (!m) {
    throw new Error(
      `viewport "${raw}" is not WIDTH,HEIGHT — expected e.g. "1280,720" or "375,667".`,
    );
  }
  const width = Number(m[1]);
  const height = Number(m[2]);
  if (width < 100 || height < 100 || width > 7680 || height > 4320) {
    throw new Error(
      `viewport ${width}x${height} out of plausible range (100-7680 wide, 100-4320 tall).`,
    );
  }
  return { width, height };
}

/** Stable wire format: `WIDTH,HEIGHT`. Always comma, no spaces. */
export function formatViewport(width: number, height: number): string {
  return `${width},${height}`;
}

// ── Classifier (Q3.1) ────────────────────────────────────────────────

/**
 * Vague-expect patterns that don't carry verifiable signal — flagged at
 * specificity-check time so the operator can refine before paying for the
 * judge call. The Q3 classifier uses these to default-down to L0 when the
 * expect text is too vague to ask Haiku/Sonnet about meaningfully.
 */
export const VAGUE_EXPECT_PATTERNS: ReadonlyArray<RegExp> = [
  /\brenders correctly\b/i,
  /\blooks (good|fine|right|ok|okay)\b/i,
  /\bworks (correctly|as expected|properly)\b/i,
  /\bis (visible|shown|displayed)\b(?!\s+(at|in|on|with|when|after|before))/i,
  /\bdisplays (correctly|properly)\b/i,
  /\bappears\b(?!\s+(at|in|on|when|after|before))/i,
];

/**
 * Returns true when the expect text contains no verifiable claim. The
 * classifier uses this signal to default-down to L0 (where vague tests
 * just confirm "page didn't crash") rather than burning Haiku/Sonnet
 * money asking "is this vague description satisfied".
 */
export function isVagueExpect(expect: string): boolean {
  if (!expect || expect.trim().length < 10) return true;
  for (const pat of VAGUE_EXPECT_PATTERNS) {
    if (pat.test(expect)) return true;
  }
  return false;
}

export interface ClassificationResult {
  level: VisualTestLevel;
  /** Human-readable reason — surfaced in the contract review UI so the
   *  operator can sanity-check classifier decisions. */
  reason: string;
  /** True when the test had `level:` already set in source — classifier
   *  honored it without overriding. */
  alreadyLeveled: boolean;
  /** Pipeline v2.0 PR-8f #2 — true when rigor floored the level below
   *  what shape-based classification would have chosen. e.g., a `flow:`
   *  test classifies as L2 by shape but rigor='prototype' forces L0;
   *  the operator-facing card shows "(forced L0 by prototype rigor)". */
  rigorFloored?: boolean;
}

/**
 * Pipeline v2.0 PR-8f #2 — rigor → max-allowed-level table per
 * redesign §6.2:
 *   • prototype  → L0 only  (smoke checks, $0/~30s for a 36-test plan)
 *   • mvp        → L0 + L1  (Haiku judge on specific elements)
 *   • production → L0 + L1 + L2 (full behavioral flows)
 *
 * Higher rigors don't *require* L2 — a test can still be L0 if its
 * shape doesn't warrant the spend. Rigor is a CEILING, not a floor.
 */
const RIGOR_MAX_LEVEL: Record<PlanRigor, VisualTestLevel> = {
  prototype: 'L0',
  mvp: 'L1',
  production: 'L2',
};

const LEVEL_ORDINAL: Record<VisualTestLevel, number> = { L0: 0, L1: 1, L2: 2 };

/** Returns the lower of two levels (cap-by-rigor helper). */
function capLevel(target: VisualTestLevel, ceiling: VisualTestLevel): VisualTestLevel {
  return LEVEL_ORDINAL[target] <= LEVEL_ORDINAL[ceiling] ? target : ceiling;
}

/**
 * Classify a single visual test. Pure function over the test's shape.
 *
 * Cascade:
 *  1. If `test.level` is set → keep it (operator/dev-author intent wins).
 *     Then cap by rigor — operator-set L2 on a prototype plan is still
 *     downgraded to L0 because prototype rigor never executes L1/L2.
 *  2. If `test.flow` has multiple steps → L2 (multi-screenshot behavioral).
 *  3. If `test.flow` has 1 step OR `test.screenshot.selector` is set AND
 *     the expect text is concrete → L1 (single-element judge).
 *  4. If only `test.url` + `test.expectText` are present → L0 (deterministic).
 *  5. Otherwise (default fallback) → L0 with "vague-expect" reason.
 *
 *  6. Final pass: floor the chosen level to rigor's ceiling per
 *     redesign §6.2. prototype caps at L0; mvp at L1; production at L2.
 *     `rigorFloored` is set when this rule actually kicked in so the
 *     operator card can show "(forced L0 by prototype rigor)".
 *
 * The "concrete expect" check is critical: an L1 test with vague expect
 * text wastes Haiku money returning "uncertain"; defaulting it to L0
 * preserves the bash-first axiom.
 *
 * @param planRigor — the plan's rigor dial. When provided, caps the
 *   classifier output at the corresponding level. Omit for callers
 *   that don't have plan context (e.g., classifier unit tests).
 */
export function classifyVisualTest(
  test: VisualTestDef,
  planRigor?: PlanRigor,
): ClassificationResult {
  // Run shape-based classification first; cap by rigor in a single
  // post-processing step so the rigorFloored flag is accurate.
  let result: Omit<ClassificationResult, 'rigorFloored'>;

  if (test.level) {
    result = {
      level: test.level,
      reason: 'level set in source — preserved',
      alreadyLeveled: true,
    };
  } else if (test.flow && test.flow.length > 1) {
    result = {
      level: 'L2',
      reason: `flow has ${test.flow.length} steps (multi-step behavioral)`,
      alreadyLeveled: false,
    };
  } else {
    const hasSelector = !!test.screenshot?.selector;
    const hasSingleStepFlow = test.flow?.length === 1;
    const concreteExpect = !isVagueExpect(test.expect);
    if ((hasSelector || hasSingleStepFlow) && concreteExpect) {
      result = {
        level: 'L1',
        reason: hasSelector
          ? 'screenshot selector + concrete expect (Haiku judge)'
          : 'single-step flow + concrete expect (Haiku judge)',
        alreadyLeveled: false,
      };
    } else if (test.url && test.expectText && test.expectText.length > 0) {
      result = {
        level: 'L0',
        reason: 'URL + expectText only (bash matcher)',
        alreadyLeveled: false,
      };
    } else {
      result = {
        level: 'L0',
        reason: concreteExpect
          ? 'no flow/screenshot/expectText — bash smoke check only'
          : 'vague expect text — defaulted to L0 to avoid wasted judge cost',
        alreadyLeveled: false,
      };
    }
  }

  // Rigor floor — last so it overrides every shape-based decision.
  if (planRigor) {
    const ceiling = RIGOR_MAX_LEVEL[planRigor];
    const capped = capLevel(result.level, ceiling);
    if (capped !== result.level) {
      return {
        ...result,
        level: capped,
        reason: `${result.reason} (forced ${capped} by ${planRigor} rigor — was ${result.level})`,
        rigorFloored: true,
      };
    }
  }

  return result;
}

// ── Coverage + specificity rollups (Q4.1) ────────────────────────────

export interface CoverageWarning {
  kind: 'no-tests-for-needs-browser' | 'over-tested' | 'tests-without-criteria-ref';
  criterionId?: string;
  testIds?: string[];
  message: string;
}

export interface SpecificityWarning {
  testId: string;
  reason: 'vague-expect' | 'missing-expect' | 'short-expect';
  message: string;
}

export interface AggregateReport {
  totalTests: number;
  byLevel: Record<VisualTestLevel, number>;
  classifications: Array<{
    testId: string;
    classification: ClassificationResult;
  }>;
  coverageWarnings: CoverageWarning[];
  specificityWarnings: SpecificityWarning[];
  /** Sum of per-test budget estimates ($). The contract review card shows
   *  this so operator sees the bill before approving. */
  estimatedCostUsd: number;
  /** Sum of per-test wall-clock estimates (seconds). */
  estimatedWallclockSec: number;
}

const DEFAULT_COST_BY_LEVEL: Record<VisualTestLevel, number> = {
  L0: 0,
  L1: 0.005,
  L2: 0.05,
};
const DEFAULT_WALLCLOCK_BY_LEVEL: Record<VisualTestLevel, number> = {
  L0: 1,
  L1: 5,
  L2: 45,
};

/**
 * Run the classifier over every test, plus the coverage + specificity
 * checks the contract-review card displays. Pure function — qa-aggregate
 * shells out to `node -e` calling this and writes the JSON sidecar.
 *
 * @param planRigor — when provided, caps every classification at the
 *   rigor's ceiling per §6.2 (prototype→L0, mvp→L1, production→L2).
 *   The contract card uses this to surface "forced by rigor" warnings
 *   so operator sees why a flow:test is running at L0.
 */
export function aggregateVisualTests(
  tests: ReadonlyArray<VisualTestDef>,
  acceptanceCriteria: ReadonlyArray<{ id: string; needsBrowser: boolean }>,
  planRigor?: PlanRigor,
): AggregateReport {
  const classifications = tests.map((t) => ({
    testId: t.id,
    classification: classifyVisualTest(t, planRigor),
  }));

  const byLevel: Record<VisualTestLevel, number> = { L0: 0, L1: 0, L2: 0 };
  for (const c of classifications) byLevel[c.classification.level] += 1;

  // Specificity: vague/missing expect text.
  const specificityWarnings: SpecificityWarning[] = [];
  for (const t of tests) {
    if (!t.expect || t.expect.trim().length === 0) {
      specificityWarnings.push({
        testId: t.id,
        reason: 'missing-expect',
        message: `test ${t.id} has no expect — cannot classify or judge`,
      });
    } else if (t.expect.trim().length < 10) {
      specificityWarnings.push({
        testId: t.id,
        reason: 'short-expect',
        message: `test ${t.id} expect is ${t.expect.trim().length} chars — too short to verify`,
      });
    } else if (isVagueExpect(t.expect)) {
      specificityWarnings.push({
        testId: t.id,
        reason: 'vague-expect',
        message: `test ${t.id} expect "${t.expect.slice(0, 80)}" is too vague — refine before approving`,
      });
    }
  }

  // Coverage: every needsBrowser AC has ≥1 test.
  const coverageWarnings: CoverageWarning[] = [];
  const testsByCriterion = new Map<string, string[]>();
  for (const t of tests) {
    if (!t.criteriaRef) {
      const orphans = testsByCriterion.get('') ?? [];
      orphans.push(t.id);
      testsByCriterion.set('', orphans);
      continue;
    }
    const list = testsByCriterion.get(t.criteriaRef) ?? [];
    list.push(t.id);
    testsByCriterion.set(t.criteriaRef, list);
  }

  const orphanIds = testsByCriterion.get('') ?? [];
  if (orphanIds.length > 0) {
    coverageWarnings.push({
      kind: 'tests-without-criteria-ref',
      testIds: orphanIds,
      message: `${orphanIds.length} test(s) have no criteriaRef — cannot map back to ACs`,
    });
  }

  for (const ac of acceptanceCriteria) {
    if (!ac.needsBrowser) continue;
    const list = testsByCriterion.get(ac.id) ?? [];
    if (list.length === 0) {
      coverageWarnings.push({
        kind: 'no-tests-for-needs-browser',
        criterionId: ac.id,
        message: `${ac.id} is needsBrowser:true but has zero visual tests — coverage gap`,
      });
    } else if (list.length > 4) {
      coverageWarnings.push({
        kind: 'over-tested',
        criterionId: ac.id,
        testIds: list,
        message: `${ac.id} has ${list.length} tests — possible over-testing`,
      });
    }
  }

  // Cost + wall-clock projections from per-test budgets falling back to
  // level defaults. Used by the contract-review card to surface the bill.
  let estimatedCostUsd = 0;
  let estimatedWallclockSec = 0;
  for (const { testId, classification } of classifications) {
    const t = tests.find((x) => x.id === testId)!;
    estimatedCostUsd +=
      t.budgetCostUsd ?? DEFAULT_COST_BY_LEVEL[classification.level];
    estimatedWallclockSec +=
      t.budgetWallclockSec ?? DEFAULT_WALLCLOCK_BY_LEVEL[classification.level];
  }

  return {
    totalTests: tests.length,
    byLevel,
    classifications,
    coverageWarnings,
    specificityWarnings,
    estimatedCostUsd,
    estimatedWallclockSec,
  };
}
