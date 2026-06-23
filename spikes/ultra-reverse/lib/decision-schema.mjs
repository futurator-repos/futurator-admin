// decision-schema.mjs — the DecisionPlan IR (design doc §2), as a plain-JS factory + validator.
//
// No zod here on purpose: the spikes harness is dependency-light bash+node (strategy §8.4).
// When this graduates to packages/ultracode-core, mirror this shape in zod (design doc §2).
//
// The IR is the normalization target both engines reduce to. Case 1 (an orchestration
// call-graph) and Case 2 (a work-breakdown DAG) both project onto "phased fan-out with
// dependency edges"; anything that does NOT project is recorded in `extraction.lossy` and
// excluded from the structural-diff denominator — never scored as a silent zero.

/** @typedef {'build-verify-fix'|'plan-synthesis-critique'|'greenfield-build'|'brownfield-harden'|'research'|'other'} Pattern */
/** @typedef {'fan-out-and-synthesize'|'adversarial-verification'|'perspective-diverse-verify'|'tournament'|'generate-and-filter'|'loop-until-done'|'classify-and-act'} QualityPattern */
/** @typedef {'adversarial'|'perspective-diverse'|'judge-panel'|'none'} VerifyKind */
/** @typedef {'sequential'|'parallel-barrier'|'streaming'} PhaseMode */

export const PATTERNS = /** @type {const} */ ([
  'build-verify-fix',
  'plan-synthesis-critique',
  'greenfield-build',
  'brownfield-harden',
  'research',
  'other',
]);

export const QUALITY_PATTERNS = /** @type {const} */ ([
  'fan-out-and-synthesize',
  'adversarial-verification',
  'perspective-diverse-verify',
  'tournament',
  'generate-and-filter',
  'loop-until-done',
  'classify-and-act',
]);

export const VERIFY_KINDS = /** @type {const} */ (['adversarial', 'perspective-diverse', 'judge-panel', 'none']);

/**
 * @typedef {object} Agent
 * @property {string} role
 * @property {boolean} hasSchema
 * @property {string} model            // model id or 'default'
 * @property {'none'|'worktree'} isolation
 * @property {string|null} [agentType] // Case 2 only (guardrail); null for Case 1
 * @property {'L0'|'L1'|'L2'|null} [testTier]
 * @property {string[]} [skillBindings]
 */

/**
 * @typedef {object} Phase
 * @property {string} name
 * @property {PhaseMode} mode
 * @property {{axis:string, width:number|'dynamic'}|null} fanOut
 * @property {Agent[]} agents
 * @property {string} [barrierReason]
 */

/**
 * @typedef {object} DecisionPlan
 * @property {Pattern} pattern
 * @property {QualityPattern[]} qualityPatterns
 * @property {Phase[]} phases
 * @property {{present:boolean, kind:VerifyKind}} verify
 * @property {number} reduceSteps
 * @property {boolean} earlyExit
 * @property {Array<[string,string]>} edges
 * @property {'case1-script'|'case2-planspec'} source
 * @property {{lossy:string[]}} extraction
 */

/** Build a DecisionPlan with safe defaults; callers override what they extract. */
export function makeDecisionPlan(partial = {}) {
  return {
    pattern: partial.pattern ?? 'other',
    qualityPatterns: partial.qualityPatterns ?? [],
    phases: partial.phases ?? [],
    verify: partial.verify ?? { present: false, kind: 'none' },
    reduceSteps: partial.reduceSteps ?? 0,
    earlyExit: partial.earlyExit ?? false,
    edges: partial.edges ?? [],
    source: partial.source ?? 'case1-script',
    extraction: partial.extraction ?? { lossy: [] },
  };
}

/**
 * Structural validation of a DecisionPlan. Returns { ok, errors[] }.
 * Cheap, dependency-free; the round-trip tests assert against this.
 */
export function validateDecisionPlan(p) {
  const errors = [];
  const must = (cond, msg) => { if (!cond) errors.push(msg); };

  must(p && typeof p === 'object', 'plan is not an object');
  if (errors.length) return { ok: false, errors };

  must(PATTERNS.includes(p.pattern), `pattern '${p.pattern}' not in enum`);
  must(Array.isArray(p.qualityPatterns), 'qualityPatterns not an array');
  for (const q of p.qualityPatterns ?? []) must(QUALITY_PATTERNS.includes(q), `qualityPattern '${q}' not in enum`);
  must(Array.isArray(p.phases) && p.phases.length >= 0, 'phases not an array');
  must(p.verify && VERIFY_KINDS.includes(p.verify.kind), `verify.kind '${p.verify?.kind}' not in enum`);
  must(typeof p.reduceSteps === 'number' && p.reduceSteps >= 0, 'reduceSteps not a non-negative number');
  must(typeof p.earlyExit === 'boolean', 'earlyExit not a boolean');
  must(Array.isArray(p.edges), 'edges not an array');
  must(p.source === 'case1-script' || p.source === 'case2-planspec', `source '${p.source}' invalid`);
  must(p.extraction && Array.isArray(p.extraction.lossy), 'extraction.lossy not an array');

  const phaseNames = new Set();
  for (const ph of p.phases ?? []) {
    must(typeof ph.name === 'string' && ph.name.length > 0, 'phase missing name');
    must(['sequential', 'parallel-barrier', 'streaming'].includes(ph.mode), `phase '${ph.name}' bad mode '${ph.mode}'`);
    must(ph.fanOut === null || (ph.fanOut && typeof ph.fanOut.axis === 'string'), `phase '${ph.name}' bad fanOut`);
    must(Array.isArray(ph.agents), `phase '${ph.name}' agents not an array`);
    phaseNames.add(ph.name);
  }
  // edges must reference declared phase names (when phases are present)
  if ((p.phases ?? []).length > 0) {
    for (const [from, to] of p.edges ?? []) {
      must(phaseNames.has(from), `edge from unknown phase '${from}'`);
      must(phaseNames.has(to), `edge to unknown phase '${to}'`);
    }
  }
  return { ok: errors.length === 0, errors };
}
