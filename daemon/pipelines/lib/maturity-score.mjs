// maturity-score.mjs — Refactoring Scan Engine v2, the codebase Maturity Scorecard.
//
// Deterministic, ~0 LLM. Derives a high-level RAG score per maturity axis from the
// scan finding pool + cheap detector summaries (tests, eslint) + flags
// (graphAvailable). The "higher overview" above the detailed findings: is this
// codebase component-driven, clutter-free, structurally sane, type-safe, secure,
// test-mature, graph-backed, spec-driven? Axes with no signal yet report
// 'unmeasured' (with a CTA) rather than a fake score.
//
// Pure JS — no I/O. The scan-engine runner feeds it; the UI renders the result.

const clamp01 = (x) => Math.max(0, Math.min(1, x));
/** Map a count to a 0..1 score: 0 issues → 1.0, `worstAt` issues → 0.0 (linear). */
const scoreFromCount = (n, worstAt) => clamp01(1 - n / worstAt);
const statusFor = (score) =>
  score == null ? 'unmeasured' : score >= 0.7 ? 'good' : score >= 0.4 ? 'fair' : 'poor';

const reInIssue = (findings, re) => findings.filter((f) => re.test(`${f.issue || ''} ${f.suggestion || ''}`)).length;
const byDim = (findings, dim) => findings.filter((f) => f.dimension === dim);
const isHotKind = (hotspots, kind) => (hotspots || []).filter((h) => h.kind === kind).length;

/**
 * @param {object} a
 *   - findings: ScanFinding[]   the deduped pool
 *   - hotspots: AuditHotspot[]  deterministic hotspots (for structural axes)
 *   - tests:   {testFiles,sourceFiles,ratio,runner,hasTests}|null   from tests-detect
 *   - eslint:  {errors,warnings,weighted,runnable}|null              from eslint-detect
 *   - graphAvailable: boolean
 *   - knipRan: boolean          whether knip actually produced data (else clutter is degraded)
 *   - sdd:     {specCount}|null  spec-driven signal (their other-session work)
 * @returns {{ axes: Array, overall: number|null }}
 */
export function computeMaturity({ findings = [], hotspots = [], tests = null, eslint = null, graphAvailable = false, knipRan = false, sdd = null } = {}) {
  const axes = [];
  const add = (key, label, score, detail, measured = true) =>
    axes.push({ key, label, score, status: statusFor(measured ? score : null), detail, measured });

  // 1. Component-driven (anti-inline): UI-centralization debt.
  const uiDebt =
    reInIssue(findings, /\bhand-?rolled\b|\binline (style|color|class)\b|\bduplicated? (ui )?component|\bdesign system\b|\bpills?\b|\bbadges?\b/i) +
    isHotKind(hotspots, 'design-system-consolidation') * 3;
  add('component-driven', 'Component-driven (anti-inline)', scoreFromCount(uiDebt, 24), `${uiDebt} UI-centralization signals`);

  // 2. Clutter / dead code (knip).
  if (knipRan) {
    const dead = byDim(findings, 'code-quality-refactoring').filter((f) => (f.evidence || {}).hotspotKind === 'dead-code').length + isHotKind(hotspots, 'dead-code');
    add('clutter', 'Dead code / clutter (knip)', scoreFromCount(dead, 30), `${dead} dead-code findings`);
  } else {
    add('clutter', 'Dead code / clutter (knip)', null, 'knip did not run — no dead-code signal', false);
  }

  // 3. Structure sanity: god-objects + duplicate subsystems.
  const structDebt = isHotKind(hotspots, 'god-object') + isHotKind(hotspots, 'duplicate-subsystem') + isHotKind(hotspots, 'low-cohesion-split');
  add('structure-sanity', 'Structure sanity (god/duplicate)', scoreFromCount(structDebt, 30), `${structDebt} god-objects / duplicate subsystems`);

  // 4. Type safety.
  const typeDebt = reInIssue(findings, /\bunsafe (type )?cast\b|\bas any\b|\bas unknown\b|without (runtime )?validation\b|\btype guard\b|\buntyped\b|: any\b/i);
  add('type-safety', 'Type safety', scoreFromCount(typeDebt, 40), `${typeDebt} unsafe-cast / unvalidated findings`);

  // 5. Security & compliance.
  const secHigh = [...byDim(findings, 'safety-security'), ...byDim(findings, 'compliance')].filter((f) => f.severity === 'High').length;
  add('security-compliance', 'Security & compliance', scoreFromCount(secHigh, 20), `${secHigh} High security/compliance findings`);

  // 6. Graph installed (always measurable).
  add('graph-installed', 'Graph installed', graphAvailable ? 1 : 0, graphAvailable ? 'code graph built' : 'no code graph', true);

  // 7. Eslint health.
  if (eslint && eslint.runnable) {
    // weighted issues per ~100 source files → score
    add('eslint-health', 'Eslint health', scoreFromCount(eslint.weighted, 400), `${eslint.errors} errors · ${eslint.warnings} warnings (code-weighted ${eslint.weighted})`);
  } else {
    add('eslint-health', 'Eslint health', null, eslint ? 'eslint not runnable (no config/deps)' : 'add eslint detector', false);
  }

  // 8. TDD maturity (tests written).
  if (tests && tests.sourceFiles != null) {
    const ratio = tests.ratio ?? (tests.sourceFiles ? tests.testFiles / tests.sourceFiles : 0);
    // ratio 0 → 0; ratio ≥ 0.3 (a test per ~3 source files) → 1.0
    const score = tests.hasTests ? clamp01(ratio / 0.3) : 0;
    add('tdd-maturity', 'TDD maturity (tests written)', score, `${tests.testFiles} test files / ${tests.sourceFiles} source (${Math.round(ratio * 100)}%)${tests.runner ? ` · ${tests.runner}` : ''}`);
  } else {
    add('tdd-maturity', 'TDD maturity (tests written)', null, 'add tests detector', false);
  }

  // 9. SDD-driven (spec-driven development).
  if (sdd && sdd.specCount != null) {
    add('sdd-driven', 'SDD-driven (specs)', scoreFromCount(Math.max(0, 8 - sdd.specCount), 8), `${sdd.specCount} spec files`);
  } else {
    add('sdd-driven', 'SDD-driven (specs)', null, 'add SDD detector (your spec work)', false);
  }

  const measured = axes.filter((a) => a.measured && typeof a.score === 'number');
  const overall = measured.length ? measured.reduce((s, a) => s + a.score, 0) / measured.length : null;
  return { axes, overall };
}
