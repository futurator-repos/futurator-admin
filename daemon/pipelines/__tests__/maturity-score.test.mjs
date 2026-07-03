/**
 * maturity-score.test.mjs — locks the Maturity Scorecard: axes derive from the
 * finding pool + detector summaries; unmeasured axes report 'unmeasured' (not a
 * fake score); RAG status thresholds hold.
 */

import { describe, it, expect } from 'vitest';
import { computeMaturity } from '../lib/maturity-score.mjs';
import { analyzeTests } from '../../scripts/refactor-recon/tests-detect.mjs';

const finding = (over) => ({ dimension: 'correctness', severity: 'Medium', issue: '', suggestion: '', evidence: {}, ...over });

describe('computeMaturity', () => {
  it('returns all quality axes (graph-installed moved to readiness)', () => {
    const { axes, readiness } = computeMaturity({});
    expect(axes.map((a) => a.key).sort()).toEqual(
      ['ai-readiness', 'branch-hygiene', 'bus-factor', 'clutter', 'commit-hygiene', 'component-driven', 'eslint-health', 'infra-declared', 'sdd-driven', 'secrets-config-hygiene', 'security-compliance', 'structure-sanity', 'tdd-maturity', 'type-safety'].sort(),
    );
    expect(axes.map((a) => a.key)).not.toContain('graph-installed');
    expect(readiness.map((r) => r.key)).toContain('graph-built');
    // ai-readiness axis is unmeasured (CTA) when no AI detector is passed; no AI readiness items.
    expect(axes.find((a) => a.key === 'ai-readiness').measured).toBe(false);
    expect(readiness.map((r) => r.key)).not.toContain('ai-onboarding');
    // git axes unmeasured (CTA) when no git detector is passed; no git readiness items.
    expect(axes.find((a) => a.key === 'branch-hygiene').measured).toBe(false);
    expect(axes.find((a) => a.key === 'commit-hygiene').measured).toBe(false);
    expect(axes.find((a) => a.key === 'bus-factor').measured).toBe(false);
    expect(readiness.map((r) => r.key)).not.toContain('git-repo');
  });

  it('AI-readiness: axis scores on breadth and adds binary readiness items when aiReadiness is passed', () => {
    const aiReadiness = {
      hasClaudeCode: true,
      skillCount: 3,
      agentCount: 2,
      commandCount: 4,
      hasMcp: true,
      hasHooks: true,
      tools: [{ name: 'AGENTS.md', present: false, detail: '', files: [] }],
      summary: '3 skills · 2 agents · MCP · hooks',
    };
    const { axes, readiness } = computeMaturity({ aiReadiness });
    const axis = axes.find((a) => a.key === 'ai-readiness');
    expect(axis.measured).toBe(true);
    expect(axis.score).toBeCloseTo(0.9); // 0.4 + 5*0.1
    expect(axis.status).toBe('good');
    // binary readiness items present only when aiReadiness passed
    expect(readiness.find((r) => r.key === 'ai-onboarding').present).toBe(true);
    expect(readiness.find((r) => r.key === 'ai-mcp').present).toBe(true);
    expect(readiness.find((r) => r.key === 'ai-skills').present).toBe(true);

    // AGENTS.md alone (no CLAUDE.md, no extras) satisfies onboarding → baseline 0.4
    const bare = computeMaturity({
      aiReadiness: { hasClaudeCode: false, skillCount: 0, agentCount: 0, commandCount: 0, hasMcp: false, hasHooks: false, tools: [{ name: 'AGENTS.md', present: true, detail: '', files: [] }], summary: 'AGENTS.md' },
    });
    expect(bare.axes.find((a) => a.key === 'ai-readiness').score).toBeCloseTo(0.4);
    expect(bare.readiness.find((r) => r.key === 'ai-onboarding').present).toBe(true);
    expect(bare.readiness.find((r) => r.key === 'ai-skills').present).toBe(false);

    // no onboarding file at all → 0
    const none = computeMaturity({
      aiReadiness: { hasClaudeCode: false, skillCount: 0, agentCount: 0, commandCount: 0, hasMcp: false, hasHooks: false, tools: [], summary: 'none' },
    });
    expect(none.axes.find((a) => a.key === 'ai-readiness').score).toBe(0);
  });

  it('Secrets & config hygiene axis: hardcoded secrets + committed .env score poor; clean scores good', () => {
    const dirty = computeMaturity({
      security: { secrets: 3, secretFiles: 1, publicSecrets: 1, weakFallbacks: 0, dangerousSinks: 2, insecureConfig: 0, env: { committedEnvFiles: 1, gitignoreCoversEnv: false, hasExample: false, usedKeys: 12, hasValidation: false }, supplyChain: { hasPackageJson: true, hasLockfile: true } },
    }).axes.find((a) => a.key === 'secrets-config-hygiene');
    expect(dirty.measured).toBe(true);
    expect(dirty.status).toBe('poor');
    expect(dirty.detail).toMatch(/secret|\.env/);

    const clean = computeMaturity({
      security: { secrets: 0, secretFiles: 0, publicSecrets: 0, weakFallbacks: 0, dangerousSinks: 0, insecureConfig: 0, env: { committedEnvFiles: 0, gitignoreCoversEnv: true, hasExample: true, usedKeys: 10, hasValidation: true }, supplyChain: { hasPackageJson: true, hasLockfile: true } },
    }).axes.find((a) => a.key === 'secrets-config-hygiene');
    expect(clean.status).toBe('good');
  });

  it('Infra-as-code axis: scores own-cloud resource declaration coverage (catches click-ops)', () => {
    // 3 own-cloud resources, only 1 declared in-repo → poor coverage (the click-ops smell)
    const infra = {
      summary: { serviceCount: 3, resourceIacFiles: 0 },
      iac: [],
      signalQuality: { level: 'medium' },
      iacCoverage: { provisionable: 3, declared: 1, ratio: 1 / 3, undeclared: ['DynamoDB', 'S3'] },
    };
    const a = computeMaturity({ infra }).axes.find((x) => x.key === 'infra-declared');
    expect(a.measured).toBe(true);
    expect(a.status).toBe('poor'); // ratio 0.33 < 0.4
    expect(a.detail).toMatch(/click-ops|undeclared/);
  });

  it('Infra-as-code axis: full declaration scores good', () => {
    const infra = {
      summary: { serviceCount: 2, resourceIacFiles: 1 },
      iac: [{ provider: 'SST', tier: 'resource' }],
      signalQuality: { level: 'high' },
      iacCoverage: { provisionable: 2, declared: 2, ratio: 1, undeclared: [] },
    };
    const a = computeMaturity({ infra }).axes.find((x) => x.key === 'infra-declared');
    expect(a.status).toBe('good');
  });

  it('Infra-as-code axis: managed/PaaS app declared as code (no own-cloud resources) → satisfied', () => {
    const infra = {
      summary: { serviceCount: 1, resourceIacFiles: 0 },
      iac: [{ provider: 'Prisma', tier: 'migrations' }],
      signalQuality: { level: 'medium' },
      iacCoverage: { provisionable: 0, declared: 0, ratio: null, undeclared: [] },
    };
    const a = computeMaturity({ infra }).axes.find((x) => x.key === 'infra-declared');
    expect(a.score).toBe(1);
  });

  it('Infra-as-code axis: rubric maturity level blends into the coverage score', () => {
    // Fully declared (coverage ratio 1) but ClickOps rubric (level 1) → blended to
    // mean(1, 0.25) = 0.625, no longer a clean "good".
    const infra = {
      summary: { serviceCount: 2, resourceIacFiles: 1 },
      iac: [{ provider: 'SST', tier: 'resource' }],
      signalQuality: { level: 'high' },
      iacCoverage: { provisionable: 2, declared: 2, ratio: 1, undeclared: [] },
      iacMaturity: {
        level: 1,
        levelName: 'Repeatable',
        dimensions: {
          state: { level: 1, evidence: 'local state file', gaps: [] },
          envSeparation: { level: 0, evidence: 'single shared config', gaps: [] },
        },
      },
    };
    const a = computeMaturity({ infra }).axes.find((x) => x.key === 'infra-declared');
    expect(a.measured).toBe(true);
    expect(a.score).toBeCloseTo((1 + 1 / 4) / 2); // mean(coverageRatio, level/4)
    expect(a.detail).toMatch(/maturity L1 Repeatable/);
    // rubric-derived readiness reflects the low dimensions
    const { readiness } = computeMaturity({ infra });
    expect(readiness.find((r) => r.key === 'remote-state').present).toBe(false); // state.level 1 < 2
    expect(readiness.find((r) => r.key === 'env-separation').present).toBe(false); // envSep.level 0 < 2
  });

  it('Infra-as-code axis: remote-state & env-separation readiness true at rubric level >= 2', () => {
    const infra = {
      summary: { serviceCount: 2, resourceIacFiles: 1 },
      iac: [{ provider: 'SST', tier: 'resource' }],
      signalQuality: { level: 'high' },
      iacCoverage: { provisionable: 2, declared: 2, ratio: 1, undeclared: [] },
      iacMaturity: {
        level: 3,
        levelName: 'Managed',
        dimensions: {
          state: { level: 3, evidence: 'S3 remote backend', gaps: [] },
          envSeparation: { level: 2, evidence: 'dev/stage/prod stacks', gaps: [] },
        },
      },
    };
    const { readiness } = computeMaturity({ infra });
    expect(readiness.find((r) => r.key === 'remote-state').present).toBe(true);
    expect(readiness.find((r) => r.key === 'env-separation').present).toBe(true);
  });

  it('Infra-as-code axis: no iacMaturity (old scan) → no blend, no rubric readiness items', () => {
    const infra = {
      summary: { serviceCount: 2, resourceIacFiles: 1 },
      iac: [{ provider: 'SST', tier: 'resource' }],
      signalQuality: { level: 'high' },
      iacCoverage: { provisionable: 2, declared: 2, ratio: 1, undeclared: [] },
      // iacMaturity intentionally absent
    };
    const { axes, readiness } = computeMaturity({ infra });
    const a = axes.find((x) => x.key === 'infra-declared');
    expect(a.score).toBe(1); // unblended coverage ratio
    expect(a.detail).not.toMatch(/maturity L/);
    expect(readiness.map((r) => r.key)).not.toContain('remote-state');
    expect(readiness.map((r) => r.key)).not.toContain('env-separation');
  });

  it('marks tests/eslint/sdd unmeasured when no summary is given; clutter degraded when knip did not run', () => {
    const { axes, readiness } = computeMaturity({ graphAvailable: true });
    const get = (k) => axes.find((a) => a.key === k);
    expect(get('tdd-maturity').status).toBe('unmeasured');
    expect(get('eslint-health').status).toBe('unmeasured');
    expect(get('sdd-driven').status).toBe('unmeasured');
    expect(get('clutter').measured).toBe(false);
    expect(readiness.find((r) => r.key === 'graph-built').present).toBe(true); // graphAvailable true
  });

  it('scores component-driven poor when UI debt is high', () => {
    const findings = Array.from({ length: 20 }, (_, i) => finding({ dimension: 'architecture', issue: `badge colors hand-rolled inline ${i}`, suggestion: 'centralized Badge' }));
    const { axes } = computeMaturity({ findings, hotspots: [{ kind: 'design-system-consolidation' }] });
    expect(axes.find((a) => a.key === 'component-driven').status).toBe('poor');
  });

  it('scores structure-sanity off god-objects/duplicates', () => {
    const hotspots = [...Array(20)].map(() => ({ kind: 'god-object' }));
    const { axes } = computeMaturity({ hotspots });
    expect(axes.find((a) => a.key === 'structure-sanity').status).toBe('poor');
  });

  it('SDD axis: spec-less → poor; diverse design intent → good', () => {
    const none = computeMaturity({ sdd: { specCount: 0, signals: 0, byType: {} } }).axes.find((a) => a.key === 'sdd-driven');
    expect(none.measured).toBe(true);
    expect(none.status).toBe('poor');
    expect(none.detail).toMatch(/characterize/);

    const rich = computeMaturity({ sdd: { specCount: 12, signals: 4, byType: { adr: 3, design: 4, apiContract: 2, prd: 3 } } }).axes.find((a) => a.key === 'sdd-driven');
    expect(rich.status).toBe('good'); // 0.3 + 0.14*4 = 0.86
  });

  it('lights up TDD maturity from a tests summary', () => {
    const { axes } = computeMaturity({ tests: { testFiles: 30, sourceFiles: 100, ratio: 0.3, runner: 'vitest', hasTests: true } });
    const tdd = axes.find((a) => a.key === 'tdd-maturity');
    expect(tdd.status).toBe('good'); // ratio 0.3 → 1.0
    expect(tdd.detail).toMatch(/vitest/);
  });

  it('Git axes: healthy repo scores well and adds git readiness items', () => {
    const git = {
      isRepo: true,
      shallow: false,
      branches: { total: 4, stale: 0, current: 'main' },
      commits: { total: 500, last30d: 40, avgSizeFiles: 3, conventionalPct: 90 },
      tags: 12,
      churnByFile: { 'a.ts': 10, 'b.ts': 5, 'c.ts': 3, 'd.ts': 2 },
      hotFiles: [{ file: 'a.ts', churn: 10 }],
      temporalCoupling: [],
      busFactor: { singleAuthorFiles: 0, topAuthors: [{ name: 'Alice', pct: 60 }] },
      summary: 'healthy',
      findings: [],
    };
    const { axes, readiness } = computeMaturity({ git });
    const branch = axes.find((a) => a.key === 'branch-hygiene');
    const commit = axes.find((a) => a.key === 'commit-hygiene');
    const bus = axes.find((a) => a.key === 'bus-factor');
    expect(branch.module).toBe('git');
    expect(branch.measured).toBe(true);
    expect(branch.score).toBe(1); // 0 stale
    expect(commit.status).toBe('good'); // 90% conventional + small commits
    expect(bus.score).toBe(1); // 0 single-author files
    expect(readiness.find((r) => r.key === 'git-repo').present).toBe(true);
    expect(readiness.find((r) => r.key === 'git-tags').present).toBe(true);
    expect(readiness.find((r) => r.key === 'conventional-commits').present).toBe(true);
  });

  it('Git axes: not a repo → unmeasured axes, git-repo readiness false', () => {
    const { axes, readiness } = computeMaturity({ git: { isRepo: false, shallow: false, tags: 0, commits: {}, branches: {}, churnByFile: {}, busFactor: {} } });
    expect(axes.find((a) => a.key === 'branch-hygiene').measured).toBe(false);
    expect(readiness.find((r) => r.key === 'git-repo').present).toBe(false);
    expect(readiness.find((r) => r.key === 'conventional-commits').present).toBe(false);
  });

  it('Git axes: stale branches + low conventional adoption score poorly', () => {
    const git = {
      isRepo: true,
      shallow: false,
      branches: { total: 20, stale: 18, current: 'main' },
      commits: { total: 300, last30d: 5, avgSizeFiles: 40, conventionalPct: 5 },
      tags: 0,
      churnByFile: { 'a.ts': 10, 'b.ts': 5 },
      busFactor: { singleAuthorFiles: 2, topAuthors: [{ name: 'Solo', pct: 95 }] },
      summary: 'risky',
      findings: [],
    };
    const { axes } = computeMaturity({ git });
    expect(axes.find((a) => a.key === 'branch-hygiene').status).toBe('poor'); // 18/20 stale
    expect(axes.find((a) => a.key === 'commit-hygiene').status).toBe('poor'); // 5% conv, huge commits
    expect(axes.find((a) => a.key === 'bus-factor').status).toBe('poor'); // 2/2 single-author
  });

  it('overall averages only measured axes', () => {
    const { overall } = computeMaturity({ graphAvailable: true });
    expect(overall).toBeGreaterThan(0);
    expect(overall).toBeLessThanOrEqual(1);
  });
});

describe('analyzeTests', () => {
  it('counts test vs source files and computes ratio', () => {
    const files = ['src/a.ts', 'src/b.ts', 'src/a.test.ts', 'src/__tests__/c.spec.ts', 'src/x.d.ts', 'README.md'];
    const r = analyzeTests(files, { runner: 'vitest' });
    expect(r.sourceFiles).toBe(2); // a.ts, b.ts (d.ts excluded, md excluded)
    expect(r.testFiles).toBe(2); // a.test.ts, c.spec.ts
    expect(r.hasTests).toBe(true);
    expect(r.ratio).toBe(1);
    expect(r.runner).toBe('vitest');
  });

  it('reports no tests cleanly', () => {
    const r = analyzeTests(['src/a.ts', 'src/b.ts']);
    expect(r.hasTests).toBe(false);
    expect(r.testFiles).toBe(0);
  });
});
