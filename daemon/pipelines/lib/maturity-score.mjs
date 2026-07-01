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
 *   - security: SecuritySummary|null from security-scan (secrets/env-hygiene axis)
 *   - stack:   StackProfile|null   used only for readiness (ts-strict) — safe to ignore if null
 *   - aiReadiness: AiReadiness|null from ai-readiness detector (AI-onboarding axis + readiness)
 * @returns {{ axes: Array, readiness: Array, overall: number|null }}
 */
export function computeMaturity({ findings = [], hotspots = [], tests = null, eslint = null, graphAvailable = false, knipRan = false, sdd = null, infra = null, security = null, stack = null, aiReadiness = null } = {}) {
  const axes = [];
  const add = (key, label, module, score, detail, measured = true) =>
    axes.push({ key, label, module, score, status: statusFor(measured ? score : null), detail, measured });

  // 1. Component-driven (anti-inline): UI-centralization debt.
  const uiDebt =
    reInIssue(findings, /\bhand-?rolled\b|\binline (style|color|class)\b|\bduplicated? (ui )?component|\bdesign system\b|\bpills?\b|\bbadges?\b/i) +
    isHotKind(hotspots, 'design-system-consolidation') * 3;
  add('component-driven', 'Component-driven (anti-inline)', 'architecture', scoreFromCount(uiDebt, 24), `${uiDebt} UI-centralization signals`);

  // 2. Clutter / dead code (knip). Score on the dead-FILE count (knip-unused +
  // zero-fan-in), not the rolled-up finding rows — 321 dead files must read poor,
  // not "good" because it's one finding row.
  if (knipRan) {
    const deadFiles = (hotspots || [])
      .filter((h) => h.kind === 'dead-code')
      .reduce((n, h) => n + ((h.evidence || {}).knipFlagged || (h.evidence || {}).confirmedZeroFanIn || 0), 0);
    const deadFindings = byDim(findings, 'code-quality-refactoring').filter((f) => (f.evidence || {}).hotspotKind === 'dead-code').length;
    const dead = Math.max(deadFiles, deadFindings);
    add('clutter', 'Dead code / clutter (knip)', 'architecture', scoreFromCount(dead, 150), `${dead} dead files`);
  } else {
    add('clutter', 'Dead code / clutter (knip)', 'architecture', null, 'knip did not run — no dead-code signal', false);
  }

  // 3. Structure sanity: god-objects + duplicate subsystems.
  const structDebt = isHotKind(hotspots, 'god-object') + isHotKind(hotspots, 'duplicate-subsystem') + isHotKind(hotspots, 'low-cohesion-split');
  add('structure-sanity', 'Structure sanity (god/duplicate)', 'architecture', scoreFromCount(structDebt, 30), `${structDebt} god-objects / duplicate subsystems`);

  // 4. Type safety.
  const typeDebt = reInIssue(findings, /\bunsafe (type )?cast\b|\bas any\b|\bas unknown\b|without (runtime )?validation\b|\btype guard\b|\buntyped\b|: any\b/i);
  add('type-safety', 'Type safety', 'code-quality', scoreFromCount(typeDebt, 40), `${typeDebt} unsafe-cast / unvalidated findings`);

  // 5. Security & compliance.
  const secHigh = [...byDim(findings, 'safety-security'), ...byDim(findings, 'compliance')].filter((f) => f.severity === 'High').length;
  add('security-compliance', 'Security & compliance', 'security', scoreFromCount(secHigh, 20), `${secHigh} High security/compliance findings`);

  // 6. Eslint health. (graph-installed is now a readiness item, not a quality axis.)
  if (eslint && eslint.runnable) {
    // weighted issues per ~100 source files → score
    add('eslint-health', 'Eslint health', 'code-quality', scoreFromCount(eslint.weighted, 400), `${eslint.errors} errors · ${eslint.warnings} warnings (code-weighted ${eslint.weighted})`);
  } else {
    add('eslint-health', 'Eslint health', 'code-quality', null, eslint ? 'eslint not runnable (no config/deps)' : 'add eslint detector', false);
  }

  // 8. TDD maturity (tests written).
  if (tests && tests.sourceFiles != null) {
    const ratio = tests.ratio ?? (tests.sourceFiles ? tests.testFiles / tests.sourceFiles : 0);
    // ratio 0 → 0; ratio ≥ 0.3 (a test per ~3 source files) → 1.0
    const score = tests.hasTests ? clamp01(ratio / 0.3) : 0;
    add('tdd-maturity', 'TDD maturity (tests written)', 'testing', score, `${tests.testFiles} test files / ${tests.sourceFiles} source (${Math.round(ratio * 100)}%)${tests.runner ? ` · ${tests.runner}` : ''}`);
  } else {
    add('tdd-maturity', 'TDD maturity (tests written)', 'testing', null, 'add tests detector', false);
  }

  // 9. SDD-driven (captured design intent). 0 specs → 0 (a spec-less brownfield can't
  //    be changed safely). Otherwise: presence (0.3) + signal DIVERSITY (ADRs / PRDs /
  //    design / stories / API-contracts, +0.14 each) — breadth of intent beats volume.
  if (sdd && sdd.specCount != null) {
    const score = sdd.specCount === 0 ? 0 : clamp01(0.3 + 0.14 * (sdd.signals || 0));
    const t = sdd.byType || {};
    const present = [
      t.adr ? `${t.adr} ADR` : '',
      t.prd ? `${t.prd} PRD` : '',
      t.designDoc || t.design ? `${t.designDoc || t.design} design` : '',
      t.story ? `${t.story} story` : '',
      t.apiContract ? `${t.apiContract} API-contract` : '',
    ].filter(Boolean).join(' · ');
    add('sdd-driven', 'SDD-driven (design intent)', 'sdd', score, sdd.specCount === 0 ? 'no captured design intent — characterize before refactor' : `${sdd.specCount} spec artifact(s): ${present || 'docs'}`);
  } else {
    add('sdd-driven', 'SDD-driven (design intent)', 'sdd', null, 'add SDD detector', false);
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
      add('infra-declared', 'Infra-as-code (declared)', 'infra', cov.ratio,
        `${cov.declared}/${cov.provisionable} cloud resources declared in-repo` +
        (undeclared > 0 ? ` · ${undeclared} used-but-undeclared (${(cov.undeclared || []).slice(0, 4).join(', ')}${undeclared > 4 ? '…' : ''}) — click-ops risk or sibling infra repo` : ' — fully declared'));
    } else if (anyResourceIac) {
      // managed/PaaS or self-hosted app whose infra IS declared as code, nothing
      // un-declarable left → property satisfied via a (possibly lighter) mechanism.
      add('infra-declared', 'Infra-as-code (declared)', 'infra', 1, 'infra declared as code (IaC / migrations / platform config)');
    } else if (infra.summary.serviceCount === 0) {
      add('infra-declared', 'Infra-as-code (declared)', 'infra', null, 'no provisionable infra detected — nothing to declare', false);
    } else {
      // services used but none own-cloud-provisionable & no resource IaC: pure 3rd-party
      // SaaS, or platform-only. Lean on the signal level rather than a hard penalty.
      const lvl = infra.signalQuality?.level;
      add('infra-declared', 'Infra-as-code (declared)', 'infra', lvl === 'high' ? 1 : lvl === 'medium' ? 0.5 : 0.25,
        infra.signalQuality?.detail || 'infra not declared in version-controlled code');
    }
  } else {
    add('infra-declared', 'Infra-as-code (declared)', 'infra', null, 'add infra detector', false);
  }

  // 11. Secrets & config hygiene — deterministic, always measurable. Hardcoded
  //     secrets / committed .env / browser-exposed secrets are weighted hardest;
  //     env-config smells (no .env.example, no validation) add lighter penalty.
  if (security) {
    const e = security.env || {};
    const critical = (security.secrets || 0) + (security.secretFiles || 0) + (security.publicSecrets || 0) + (security.weakFallbacks || 0);
    const weighted =
      critical * 2 +
      (e.committedEnvFiles > 0 ? 3 : 0) +
      (e.committedEnvFiles > 0 && !e.gitignoreCoversEnv ? 2 : 0) +
      (!e.hasExample && e.usedKeys > 0 ? 1 : 0) +
      (e.usedKeys >= 8 && !e.hasValidation ? 1 : 0) +
      (security.dangerousSinks || 0) * 0.5 +
      (security.insecureConfig || 0) * 0.5 +
      (security.supplyChain && security.supplyChain.hasPackageJson && !security.supplyChain.hasLockfile ? 1 : 0);
    const bits = [];
    if (critical) bits.push(`${critical} secret/leak`);
    if (e.committedEnvFiles) bits.push(`${e.committedEnvFiles} committed .env`);
    if (!e.hasExample && e.usedKeys) bits.push('no .env.example');
    if (security.dangerousSinks) bits.push(`${security.dangerousSinks} dangerous sink(s)`);
    add('secrets-config-hygiene', 'Secrets & config hygiene', 'security', scoreFromCount(weighted, 12), bits.length ? bits.join(' · ') : 'no secret/env-hygiene issues found');
  } else {
    add('secrets-config-hygiene', 'Secrets & config hygiene', 'security', null, 'add security detector', false);
  }

  // 12. AI-readiness (agent-onboarding) — breadth of agent-facing scaffolding:
  //     CLAUDE.md / AGENTS.md instructions (baseline), then +0.1 each for skills,
  //     subagents, MCP, hooks, and slash-commands. No AI-onboarding file at all → 0.
  const aiAgentsMd = (aiReadiness?.tools || []).some((t) => /agents\.md/i.test(t.name) && t.present);
  if (aiReadiness) {
    const score = !aiReadiness.hasClaudeCode && !aiAgentsMd
      ? 0
      : clamp01(
          0.4 +
            0.1 * (aiReadiness.skillCount > 0) +
            0.1 * (aiReadiness.agentCount > 0) +
            0.1 * !!aiReadiness.hasMcp +
            0.1 * !!aiReadiness.hasHooks +
            0.1 * (aiReadiness.commandCount > 0),
        );
    add('ai-readiness', 'AI-readiness (agent onboarding)', 'ai', score, aiReadiness.summary || `${aiReadiness.skillCount} skills · ${aiReadiness.agentCount} agents`);
  } else {
    add('ai-readiness', 'AI-readiness (agent onboarding)', 'ai', null, 'add AI detector', false);
  }

  const measured = axes.filter((a) => a.measured && typeof a.score === 'number');
  const overall = measured.length ? measured.reduce((s, a) => s + a.score, 0) / measured.length : null;

  // Readiness — binary checks (NOT scored quality). Derived from the same summaries.
  const readiness = [];
  const addR = (key, label, present, detail) => readiness.push({ key, label, present: !!present, detail });
  addR('graph-built', 'Code graph built', graphAvailable, graphAvailable ? 'code graph available' : 'run graph build (graphify)');
  addR('iac-present', 'Infra-as-code present', infra ? (infra.signalQuality?.iacDeclared || (infra.iac || []).length > 0) : false,
    infra ? 'IaC declared in repo' : 'no infra summary — run infra detector');
  addR('tests-present', 'Tests present', tests ? tests.hasTests : false, tests ? (tests.hasTests ? `${tests.testFiles} test files` : 'no test files found') : 'run tests detector');
  addR('lockfile', 'Dependency lockfile', security ? security.supplyChain?.hasLockfile : false,
    security ? (security.supplyChain?.hasLockfile ? 'lockfile committed' : 'no lockfile — pin dependencies') : 'run security detector');
  addR('env-example', '.env.example present', security ? security.env?.hasExample : false,
    security ? (security.env?.hasExample ? '.env.example committed' : 'add a .env.example') : 'run security detector');
  addR('eslint-config', 'ESLint configured', eslint ? eslint.runnable : false,
    eslint ? (eslint.runnable ? 'eslint runnable' : 'eslint not runnable (no config/deps)') : 'run eslint detector');
  addR('specs-present', 'Specs present', sdd ? (sdd.hasSpecs ?? (sdd.specCount || 0) > 0) : false,
    sdd ? ((sdd.hasSpecs ?? (sdd.specCount || 0) > 0) ? `${sdd.specCount ?? '?'} spec artifact(s)` : 'no captured specs/design intent') : 'run SDD detector');
  const tsStrict = !!(stack && (stack.frameworks || []).some((f) => /typescript|\bts\b/i.test(f)) && stack.tsStrict);
  addR('ts-strict', 'TypeScript strict', tsStrict, tsStrict ? 'strict mode on' : 'unknown or not strict');

  // AI-onboarding readiness — only when the AI detector ran.
  if (aiReadiness) {
    const onboarding = aiReadiness.hasClaudeCode || aiAgentsMd;
    addR('ai-onboarding', 'AI agent onboarding', onboarding, onboarding ? 'CLAUDE.md / AGENTS.md present' : 'no CLAUDE.md or AGENTS.md');
    addR('ai-mcp', 'MCP servers configured', aiReadiness.hasMcp, aiReadiness.hasMcp ? 'MCP config present' : 'no MCP servers configured');
    addR('ai-skills', 'Agent skills', aiReadiness.skillCount > 0, aiReadiness.skillCount > 0 ? `${aiReadiness.skillCount} skill(s)` : 'no agent skills');
  }

  return { axes, readiness, overall };
}
