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
  it('returns all nine axes', () => {
    const { axes } = computeMaturity({});
    expect(axes.map((a) => a.key).sort()).toEqual(
      ['clutter', 'component-driven', 'eslint-health', 'graph-installed', 'sdd-driven', 'security-compliance', 'structure-sanity', 'tdd-maturity', 'type-safety'].sort(),
    );
  });

  it('marks tests/eslint/sdd unmeasured when no summary is given; clutter degraded when knip did not run', () => {
    const { axes } = computeMaturity({ graphAvailable: true });
    const get = (k) => axes.find((a) => a.key === k);
    expect(get('tdd-maturity').status).toBe('unmeasured');
    expect(get('eslint-health').status).toBe('unmeasured');
    expect(get('sdd-driven').status).toBe('unmeasured');
    expect(get('clutter').measured).toBe(false);
    expect(get('graph-installed').status).toBe('good'); // graphAvailable true
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
