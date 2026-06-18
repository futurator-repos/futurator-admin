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
  VerifyIntent,
  ManualReason,
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
  /** VQA v3 (E4-S2 / FR-13) — the resolved oracle tier derived from the
   *  linked AC's `verify` intent + whether the app ships a test-harness
   *  seam, then capped by the vision-only rigor rule. Distinct from the
   *  wire-level `level` (L0/L1/L2) the runtime uses to pick a judge step;
   *  this is the operator-facing "how is this actually verified" tier
   *  (e.g. `L2-state` = deterministic seam read, rigor-exempt). Only set
   *  when the AC carried a `verify` intent. */
  resolvedLevel?: ResolvedLevel;
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
 *  6. Floor the chosen level to rigor's ceiling per redesign §6.2.
 *     prototype caps at L0; mvp at L1; production at L2.
 *     `rigorFloored` is set when this rule kicked in.
 *
 *  7. PR-62 (2026-05-15) — needsBrowser floor. If the AC linked to this
 *     test has `needsBrowser: true`, the level CANNOT be L0. L0 only
 *     checks HTTP 200 + screenshot non-blank + console errors + optional
 *     expectText substring — none of which can verify that a button is
 *     visible, a chart has data, an animation plays, or a game canvas
 *     has the expected entities. Browser-tagged ACs require pixel-level
 *     judgment, which only L1+ provides. This OVERRIDES the rigor cap
 *     (a `prototype` plan with browser ACs still pays for L1 — operators
 *     who don't want the cost should mark the AC `needsBrowser: false`).
 *     spyhunter-1 forensic 2026-05-13: 26 browser ACs silently passed at
 *     L0 because the page rendered, even though most of the game
 *     content (enemies, gadgets, boss) was missing.
 *
 * @param planRigor — the plan's rigor dial. When provided, caps the
 *   classifier output at the corresponding level. Omit for callers
 *   that don't have plan context (e.g., classifier unit tests).
 * @param acNeedsBrowser — when true, raises the floor to L1 because
 *   pixel-level verification is required. Pass the AC's `needsBrowser`
 *   flag from the story spec; omit for callers that don't have AC
 *   context.
 */
export function classifyVisualTest(
  test: VisualTestDef,
  planRigor?: PlanRigor,
  acNeedsBrowser?: boolean,
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

  // Rigor cap — applied before the needsBrowser floor so that
  // needsBrowser can override even a rigor-capped L0.
  let level = result.level;
  let reason = result.reason;
  let rigorFloored = false;
  if (planRigor) {
    const ceiling = RIGOR_MAX_LEVEL[planRigor];
    const capped = capLevel(level, ceiling);
    if (capped !== level) {
      reason = `${reason} (forced ${capped} by ${planRigor} rigor — was ${level})`;
      level = capped;
      rigorFloored = true;
    }
  }

  // PR-62 — needsBrowser floor (after rigor cap so it wins).
  if (acNeedsBrowser && level === 'L0') {
    reason = `${reason} (raised to L1: AC needsBrowser — L0 cannot verify visual behavior)`;
    level = 'L1';
    // Not a rigor floor — clear the flag in case rigor capped earlier;
    // operator-facing card should attribute the raise to needsBrowser.
    rigorFloored = false;
  }

  return {
    ...result,
    level,
    reason,
    ...(rigorFloored ? { rigorFloored: true } : {}),
  };
}

// ── VQA v3 (E5.4 / FR-11..13) — verify-based level + vision-only rigor cap ──

/**
 * The resolved oracle tier. L2 splits into:
 *   • L2-state  — deterministic seam read (window.__harness). FREE, flake-free.
 *   • L2-vision — LLM judges a post-interaction frame.
 * Plus the human lane for `manual`. This is the QA-AUTHOR's working vocabulary
 * (E8); it does NOT replace the wire-level `VisualTestLevel` (L0/L1/L2) that the
 * existing classifier + reports use — keeping the blast radius contained.
 *
 *   • needs-probe — a `state`/`behavior` AC that would earn the deterministic
 *     `L2-state` tier but carries NO executable probe (no `assert` flow step /
 *     `window.__harness` read). It is honestly unverifiable: surfaced as such
 *     instead of being handed to a vision judge it can't satisfy (F13).
 */
export type ResolvedLevel = 'L0' | 'L1' | 'L2-state' | 'L2-vision' | 'operator' | 'needs-probe';

/**
 * F13 — does this test carry an EXECUTABLE deterministic probe? A `state`/
 * `behavior` AC only earns the `L2-state` oracle tier if at least one of its
 * flow steps is an `assert` (the `window.__harness` read the runtime executes
 * in `runFlow`). A flow-less test, or a flow with no `assert`, is partitioned
 * to the plain-test lane and never runs an assert — so it cannot honestly claim
 * the deterministic tier.
 */
export function hasExecutableProbe(test: Pick<VisualTestDef, 'flow'>): boolean {
  return Array.isArray(test.flow) && test.flow.some((s) => s.action === 'assert');
}

/** Deterministic tiers run flake-free for ~$0 — and are therefore rigor-EXEMPT. */
export function isDeterministicLevel(level: ResolvedLevel): level is 'L0' | 'L2-state' {
  return level === 'L0' || level === 'L2-state';
}

/**
 * F13 — map a resolved oracle tier back to the wire-level `VisualTestLevel`
 * the runtime uses to pick a judge step. Returns `undefined` for tiers that
 * don't pin a wire level (`L2-state` runs a flow but deterministically; the
 * human `operator` lane and the honest `needs-probe` state aren't wire-routed),
 * so callers leave the existing `level` untouched for those.
 */
export function wireLevelForResolved(tier: ResolvedLevel): VisualTestLevel | undefined {
  switch (tier) {
    case 'L0':
      return 'L0';
    case 'L1':
      return 'L1';
    case 'L2-vision':
      return 'L2';
    default:
      return undefined; // L2-state / operator / needs-probe — not a vision wire tier
  }
}

/** F13 — wire-level cost order L0 < L1 < L2, used to compare two wire levels. */
const WIRE_COST: Record<VisualTestLevel, number> = { L0: 0, L1: 1, L2: 2 };
export function isCheaperWire(candidate: VisualTestLevel, current: VisualTestLevel): boolean {
  return WIRE_COST[candidate] < WIRE_COST[current];
}

/**
 * FR-13 — derive the oracle tier from the PM's `verify` intent + whether a
 * test-harness seam exists for the app:
 *   build→L0 · appearance→L1 · state→(seam? L2-state : L1) ·
 *   behavior→(seam? L2-state : L2-vision) · manual→operator lane.
 */
export function deriveLevelFromVerify(
  verify: VerifyIntent | undefined,
  hasSeam: boolean,
): ResolvedLevel {
  switch (verify) {
    case 'build':
      return 'L0';
    case 'appearance':
      return 'L1';
    case 'state':
      return hasSeam ? 'L2-state' : 'L1';
    case 'behavior':
      return hasSeam ? 'L2-state' : 'L2-vision';
    case 'manual':
      return 'operator';
    default:
      // No verify intent → fall back to the shape classifier's world (L1 vision).
      return 'L1';
  }
}

/**
 * E8.2 (W5/H12 / MQ1-followup) — the ONE `needsBrowser` rule all three docs
 * share: DERIVED for `build|appearance|state|behavior` (`build→false`, the rest
 * `true` — they need a running surface), and INDEPENDENT/EXPLICIT for `manual`
 * (returns `undefined` → the caller keeps the operator-set flag; a manual AC's
 * browser-need is a human-lane fact, not derivable from intent). Centralizes
 * the rule so the classifier, the QA-AUTHOR, and the gate never diverge.
 */
export function deriveNeedsBrowser(verify: VerifyIntent | undefined): boolean | undefined {
  switch (verify) {
    case 'build':
      return false;
    case 'appearance':
    case 'state':
    case 'behavior':
      return true;
    case 'manual':
      return undefined; // independent — caller keeps the explicit value
    default:
      return undefined; // no intent → leave the existing flag alone
  }
}

/**
 * E8.3 (W5/H12) — the `manual→behavior` downgrade decision, owned by the
 * QA-AUTHOR (Concept's gate only FLAGS `manual`; it must not reclassify — the
 * W5 altitude rule). Stub-availability is a mechanism fact known only at
 * story-dev start: if a test-mode boundary seam exists for this AC's boundary
 * (`stubAvailable`), a `verify:'manual'` AC is NOT genuinely unautomatable —
 * downgrade it to `behavior`, FORCE `needsBrowser:true`, and emit a logged
 * reclassification event so `manual` can't become the new UNVERIFIABLE escape
 * hatch. A genuinely unautomatable AC (no stub) stays `manual` → operator lane.
 *
 * Pure decision only; the daemon emits the returned `event` into the reflection
 * sink. Non-manual ACs pass through unchanged.
 */
export interface ManualDowngradeDecision {
  verify: VerifyIntent;
  /** Forced true on downgrade; undefined when unchanged (caller keeps explicit). */
  needsBrowser?: boolean;
  reclassified: boolean;
  /** Logged reclassification event payload (null when no change). */
  event: {
    kind: 'manual-downgrade';
    acId: string;
    from: 'manual';
    to: 'behavior';
    manualReason?: ManualReason;
    reason: string;
  } | null;
}

export function downgradeManualToBehavior(args: {
  acId: string;
  verify: VerifyIntent | undefined;
  manualReason?: ManualReason;
  /** Does a test-mode boundary seam exist for this AC's boundary (E11.3/E11.4)? */
  stubAvailable: boolean;
}): ManualDowngradeDecision {
  if (args.verify !== 'manual') {
    return { verify: args.verify ?? 'behavior', reclassified: false, event: null };
  }
  if (!args.stubAvailable) {
    // Genuinely unautomatable → stays manual, routes to the operator lane (E11).
    return { verify: 'manual', reclassified: false, event: null };
  }
  // Stubbable boundary → automate it deterministically.
  return {
    verify: 'behavior',
    needsBrowser: true,
    reclassified: true,
    event: {
      kind: 'manual-downgrade',
      acId: args.acId,
      from: 'manual',
      to: 'behavior',
      manualReason: args.manualReason,
      reason: `boundary is stubbable (test-mode seam available) — automated as behavior; manual would be a false escape hatch`,
    },
  };
}

const VISION_ORDINAL: Record<'L0' | 'L1' | 'L2-vision', number> = {
  L0: 0,
  L1: 1,
  'L2-vision': 2,
};
const RIGOR_VISION_CEILING: Record<PlanRigor, 'L0' | 'L1' | 'L2-vision'> = {
  prototype: 'L0', // no paid vision on a throwaway
  mvp: 'L1',
  production: 'L2-vision',
};

/**
 * R1 — the split rigor cap. Rigor is a COST ceiling on **vision tiers only**
 * (L1 / L2-vision). Deterministic tiers (L0, L2-state) and the operator lane are
 * EXEMPT — a `prototype` plan still runs an L2-state assert (it's free), which is
 * exactly the disease the old "prototype→L0 for everything" cap re-introduced.
 * This is the single highest-risk, easiest-to-miss requirement — keep it tested.
 */
export function capVisionLevelByRigor(level: ResolvedLevel, rigor: PlanRigor): ResolvedLevel {
  if (isDeterministicLevel(level) || level === 'operator' || level === 'needs-probe') return level; // exempt — needs-probe is the unverifiable lane, never a vision tier
  const ceiling = RIGOR_VISION_CEILING[rigor];
  return VISION_ORDINAL[level] <= VISION_ORDINAL[ceiling] ? level : ceiling;
}

// ── Coverage + specificity rollups (Q4.1) ────────────────────────────

export interface CoverageWarning {
  kind:
    | 'no-tests-for-needs-browser'
    | 'over-tested'
    | 'tests-without-criteria-ref'
    | 'weak-oracle'
    | 'unpaired-l2-state';
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

/**
 * Per-test cost in USD by routing level. L0 is pure bash (free), L1 is
 * one Haiku call (~$0.005 average), L2 is one Sonnet call (~$0.05 avg).
 *
 * Exported so the ContractGate UI can recompute the total live as the
 * operator changes per-test levels without a backend roundtrip.
 */
export const DEFAULT_COST_BY_LEVEL: Record<VisualTestLevel, number> = {
  L0: 0,
  L1: 0.005,
  L2: 0.05,
};
/**
 * Per-test wall-clock in seconds by routing level. Same purpose as
 * `DEFAULT_COST_BY_LEVEL` — feeds the ContractGate's live "~Ns" chip.
 */
export const DEFAULT_WALLCLOCK_BY_LEVEL: Record<VisualTestLevel, number> = {
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
  acceptanceCriteria: ReadonlyArray<{ id: string; needsBrowser: boolean; verify?: VerifyIntent }>,
  planRigor?: PlanRigor,
  hasSeam = false,
): AggregateReport {
  // PR-62 — index needsBrowser by AC id so per-test classification can
  // raise the floor for browser-tagged criteria. Tests whose criteriaRef
  // doesn't match any AC default to acNeedsBrowser=false (safest — they
  // get the shape-based level + rigor cap only).
  const needsBrowserByAcId = new Map<string, boolean>();
  // VQA v3 (E4-S2) — index verify intent by AC id so each test can resolve
  // its oracle tier (L2-state vs L2-vision vs …) from the PM's intent.
  const verifyByAcId = new Map<string, VerifyIntent | undefined>();
  for (const ac of acceptanceCriteria) {
    needsBrowserByAcId.set(ac.id, ac.needsBrowser);
    verifyByAcId.set(ac.id, ac.verify);
  }

  const classifications = tests.map((t) => {
    const acNeedsBrowser = t.criteriaRef ? (needsBrowserByAcId.get(t.criteriaRef) ?? false) : false;
    const classification = classifyVisualTest(t, planRigor, acNeedsBrowser);
    // Resolve the verify-derived oracle tier (FR-13), capped by the
    // vision-only rigor rule (FR-12 / R1: L2-state stays free + exempt).
    const verify = t.criteriaRef ? verifyByAcId.get(t.criteriaRef) : undefined;
    if (verify) {
      const resolved = deriveLevelFromVerify(verify, hasSeam);
      let tier = planRigor ? capVisionLevelByRigor(resolved, planRigor) : resolved;
      // F13 — a `state`/`behavior` AC only earns the deterministic `L2-state`
      // tier if the test actually ships an executable probe (an `assert` flow
      // step the runtime reads from `window.__harness`). A flow-less test is
      // partitioned to the plain-test lane and NEVER runs an assert, so it
      // cannot satisfy L2-state. Don't hand it to a vision judge it can't
      // satisfy either — mark it `needs-probe` so it surfaces honestly.
      if (tier === 'L2-state' && !hasExecutableProbe(t)) {
        tier = 'needs-probe';
      }
      classification.resolvedLevel = tier;
      // F13 — honor the resolvedLevel as the cheapest-correct oracle: stop
      // preserving a worse source-set wire `level` over a better resolved tier.
      // A deterministic `L2-state` read is free + flake-free, so a test the
      // dev-author hard-coded to an expensive vision tier should route by the
      // resolved oracle, not the stale source level.
      const wire = wireLevelForResolved(tier);
      if (wire && classification.alreadyLeveled && isCheaperWire(wire, classification.level)) {
        classification.level = wire;
        classification.reason = `${classification.reason} (re-routed to ${wire} by resolved oracle ${tier} — cheapest-correct)`;
        classification.alreadyLeveled = false;
      }
    }
    return { testId: t.id, classification };
  });

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

  // VQA v3 (E4-S3 / FR-16) — oracle-STRENGTH check, not just presence. When a
  // seam exists and an AC is `state`/`behavior`, at least one of its tests must
  // carry an `assert` step (the deterministic L2-state oracle). A state/behavior
  // AC backed only by a vision screenshot is the exact disease the seam cures —
  // flag it so the QA-AUTHOR adds the assert before the gate.
  if (hasSeam) {
    for (const ac of acceptanceCriteria) {
      if (ac.verify !== 'state' && ac.verify !== 'behavior') continue;
      const list = testsByCriterion.get(ac.id) ?? [];
      if (list.length === 0) continue; // already flagged by the presence check
      const hasAssert = list.some((id) => {
        const t = tests.find((x) => x.id === id);
        return t?.flow?.some((s) => s.action === 'assert');
      });
      if (!hasAssert) {
        coverageWarnings.push({
          kind: 'weak-oracle',
          criterionId: ac.id,
          testIds: list,
          message: `${ac.id} is verify:${ac.verify} and a seam exists, but no test asserts window.__harness — add an 'assert' probe (vision-only is non-deterministic here)`,
        });
        continue; // no assert → the weak-oracle warning already covers it
      }
      // E5.6 / E8.4-AC2 (H3/FR-32/FR-35) — L2-state is NEVER the sole witness
      // for a UI-bearing AC. The seam reports state the user never SAW; a
      // "right state, broken/invisible UI" defect ships green if state is the
      // only oracle. Require a paired vision frame (a `screenshot` step) in at
      // least one of the AC's probes so render-class defects are still caught.
      const needsBrowser = needsBrowserByAcId.get(ac.id) ?? false;
      if (!needsBrowser) continue; // non-UI state AC: deterministic-only is fine
      const hasPairedVision = list.some((id) => {
        const t = tests.find((x) => x.id === id);
        return t?.flow?.some((s) => s.action === 'screenshot');
      });
      if (!hasPairedVision) {
        coverageWarnings.push({
          kind: 'unpaired-l2-state',
          criterionId: ac.id,
          testIds: list,
          message: `${ac.id} is a UI-bearing ${ac.verify} AC verified by L2-state alone — add a paired vision frame (a 'screenshot' step) so a right-state/broken-UI defect can't ship green (H3: L2-state cannot block-green for render-class)`,
        });
      }
    }
  }

  // Cost + wall-clock projections from per-test budgets falling back to
  // level defaults. Used by the contract-review card to surface the bill.
  let estimatedCostUsd = 0;
  let estimatedWallclockSec = 0;
  for (const { testId, classification } of classifications) {
    const t = tests.find((x) => x.id === testId)!;
    estimatedCostUsd += t.budgetCostUsd ?? DEFAULT_COST_BY_LEVEL[classification.level];
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
