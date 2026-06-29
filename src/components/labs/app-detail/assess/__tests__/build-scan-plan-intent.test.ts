import { describe, it, expect } from 'vitest';
import { buildScanPlanIntent } from '../scan-report';
import type { ScanReport } from '@/hooks/use-scan-engine';

const report = {
  findings: [
    {
      id: 'a',
      dimension: 'safety-security',
      area: 'x',
      severity: 'High',
      effort: 'Trivial',
      location: 'src/a.ts:1',
      issue: 'API key logged',
      suggestion: 'redact',
      source: 'llm',
    },
    {
      id: 'b',
      dimension: 'code-quality-refactoring',
      area: 'x',
      severity: 'Medium',
      effort: 'Small',
      location: 'src/b.ts:2',
      issue: 'magic numbers',
      suggestion: 'centralize constants',
      source: 'llm',
    },
    {
      id: 'c',
      dimension: 'correctness',
      area: 'x',
      severity: 'High',
      effort: 'Small',
      location: 'src/c.ts:3',
      issue: 'no res.ok',
      suggestion: 'apiFetch',
      source: 'llm',
    },
  ],
  phases: [
    { phase: 0, name: 'Stop-the-bleeding', why: 'free', tag: 'low', items: ['a'] },
    { phase: 1, name: 'Constants', why: 'foundation', tag: 'low', items: ['b'] },
    { phase: 5, name: 'Correctness', why: 'isolated', tag: 'med', items: ['c'] },
  ],
  gateViolations: [],
  counts: { total: 3, deterministic: 0, llm: 3, byDimension: {} },
  lowConfidence: false,
} as unknown as ScanReport;

describe('buildScanPlanIntent', () => {
  it('returns empty when nothing selected', () => {
    expect(buildScanPlanIntent(report, new Set())).toBe('');
  });

  it('includes only selected phases, in phase order, with Strangler-Fig framing', () => {
    const intent = buildScanPlanIntent(report, new Set([0, 1]));
    expect(intent).toMatch(/Strangler-Fig/);
    expect(intent).toMatch(/characterization test net BEFORE/);
    expect(intent).toContain('Phase 0 — Stop-the-bleeding');
    expect(intent).toContain('Phase 1 — Constants');
    expect(intent).not.toContain('Phase 5');
    // the selected phases' findings appear
    expect(intent).toContain('API key logged');
    expect(intent).toContain('magic numbers');
    expect(intent).not.toContain('no res.ok');
    // phase 0 precedes phase 1 in the text (dependency order)
    expect(intent.indexOf('Phase 0')).toBeLessThan(intent.indexOf('Phase 1'));
  });

  it('caps at 2000 chars', () => {
    const big = {
      ...report,
      findings: Array.from({ length: 200 }, (_, i) => ({
        id: `f${i}`,
        dimension: 'correctness',
        area: 'x',
        severity: 'High',
        effort: 'Small',
        location: `src/file-${i}.ts:${i}`,
        issue: `a fairly long issue description number ${i}`,
        suggestion: `a fairly long suggestion to fix issue ${i}`,
        source: 'llm',
      })),
      phases: [
        {
          phase: 5,
          name: 'Correctness',
          why: 'isolated',
          tag: 'med',
          items: Array.from({ length: 200 }, (_, i) => `f${i}`),
        },
      ],
    } as unknown as ScanReport;
    const intent = buildScanPlanIntent(big, new Set([5]));
    expect(intent.length).toBeLessThanOrEqual(2000);
    expect(intent).toMatch(/truncated/);
  });
});
