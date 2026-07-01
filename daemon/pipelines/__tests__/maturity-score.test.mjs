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
      ['clutter', 'component-driven', 'eslint-health', 'infra-declared', 'sdd-driven', 'secrets-config-hygiene', 'security-compliance', 'structure-sanity', 'tdd-maturity', 'type-safety'].sort(),
    );
    expect(axes.map((a) => a.key)).not.toContain('graph-installed');
    expect(readiness.map((r) => r.key)).toContain('graph-built');
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
