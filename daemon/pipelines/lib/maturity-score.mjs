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
 *   - infra:   InfraInventory|null  from infra-extract (for the Infra-as-code axis)
 * @returns {{ axes: Array, overall: number|null }}
 */
export function computeMaturity({ findings = [], hotspots = [], tests = null, eslint = null, graphAvailable = false, knipRan = false, sdd = null, infra = null } = {}) {
  const axes = [];
  const add = (key, label, score, detail, measured = true) =>
    axes.push({ key, label, score, status: statusFor(measured ? score : null), detail, measured });

  // 1. Component-driven (anti-inline): UI-centralization debt.
  const uiDebt =
    reInIssue(findings, /\bhand-?rolled\b|\binline (style|color|class)\b|\bduplicated? (ui )?component|\bdesign system\b|\bpills?\b|\bbadges?\b/i) +
    isHotKind(hotspots, 'design-system-consolidation') * 3;
  add('component-driven', 'Component-driven (anti-inline)', scoreFromCount(uiDebt, 24), `${uiDebt} UI-centralization signals`);

  // 2. Clutter / dead code (knip). Score on the dead-FILE count (knip-unused +
  // zero-fan-in), not the rolled-up finding rows — 321 dead files must read poor,
  // not "good" because it's one finding row.
  if (knipRan) {
    const deadFiles = (hotspots || [])
      .filter((h) => h.kind === 'dead-code')
      .reduce((n, h) => n + ((h.evidence || {}).knipFlagged || (h.evidence || {}).confirmedZeroFanIn || 0), 0);
    const deadFindings = byDim(findings, 'code-quality-refactoring').filter((f) => (f.evidence || {}).hotspotKind === 'dead-code').length;
    const dead = Math.max(deadFiles, deadFindings);
    add('clutter', 'Dead code / clutter (knip)', scoreFromCount(dead, 150), `${dead} dead files`);
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

  // 10. Infra-as-code (declared) — the cost-center precondition + agent-tractability
  //     ("Futurator-ready"). Scores the PROPERTY (infra declared in version-controlled
  //     code), NOT the artifact: true-IaC/CDK/SST/Pulumi, schema migrations, or
  //     platform-config all satisfy it. The smell it catches: own-cloud resources USED
  //     in code (SDK/env) but declared NOWHERE in the repo — click-ops, invisible to
  //     cost estimation / audit / reproduction. (Caveat in the detail: undeclared
  //     resources might live in a sibling infra repo a single-app upload can't see.)
  if (infra && infra.summary) {
    const cov = infra.iacCoverage || infra.summary.iacCoverage;
    const anyResourceIac = (infra.summary.resourceIacFiles || 0) > 0 || (infra.iac || []).some((i) => i.tier === 'resource' || i.tier === 'migrations');
    if (cov && cov.provisionable > 0) {
      // ratio of own-cloud resources declared in-repo vs only inferred-from-usage
      const undeclared = cov.provisionable - cov.declared;
      add('infra-declared', 'Infra-as-code (declared)', cov.ratio,
        `${cov.declared}/${cov.provisionable} cloud resources declared in-repo` +
        (undeclared > 0 ? ` · ${undeclared} used-but-undeclared (${(cov.undeclared || []).slice(0, 4).join(', ')}${undeclared > 4 ? '…' : ''}) — click-ops risk or sibling infra repo` : ' — fully declared'));
    } else if (anyResourceIac) {
      // managed/PaaS or self-hosted app whose infra IS declared as code, nothing
      // un-declarable left → property satisfied via a (possibly lighter) mechanism.
      add('infra-declared', 'Infra-as-code (declared)', 1, 'infra declared as code (IaC / migrations / platform config)');
    } else if (infra.summary.serviceCount === 0) {
      add('infra-declared', 'Infra-as-code (declared)', null, 'no provisionable infra detected — nothing to declare', false);
    } else {
      // services used but none own-cloud-provisionable & no resource IaC: pure 3rd-party
      // SaaS, or platform-only. Lean on the signal level rather than a hard penalty.
      const lvl = infra.signalQuality?.level;
      add('infra-declared', 'Infra-as-code (declared)', lvl === 'high' ? 1 : lvl === 'medium' ? 0.5 : 0.25,
        infra.signalQuality?.detail || 'infra not declared in version-controlled code');
    }
  } else {
    add('infra-declared', 'Infra-as-code (declared)', null, 'add infra detector', false);
  }

  const measured = axes.filter((a) => a.measured && typeof a.score === 'number');
  const overall = measured.length ? measured.reduce((s, a) => s + a.score, 0) / measured.length : null;
  return { axes, overall };
}
