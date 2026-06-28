import { describe, it, expect } from 'vitest';
import {
  scanFindingSchema,
  severityRank,
  effortRank,
  compareFindings,
  type ScanFinding,
} from '../scan-finding-schema';

const base: ScanFinding = {
  id: 'f1',
  dimension: 'architecture',
  area: '§sys:lib',
  severity: 'High',
  effort: 'Small',
  location: 'src/lib/x.ts:10',
  issue: 'dead file',
  suggestion: 'delete x.ts',
  evidence: {},
  source: 'deterministic',
  dependsOn: [],
};

describe('scanFindingSchema', () => {
  it('accepts a well-formed finding and applies defaults', () => {
    const r = scanFindingSchema.safeParse({
      id: 'f1',
      dimension: 'correctness',
      area: 'cross-cutting',
      severity: 'Medium',
      effort: 'Medium',
      location: 'a.ts:1',
      issue: 'x',
      suggestion: 'y',
      source: 'llm',
    });
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.evidence).toEqual({});
      expect(r.data.dependsOn).toEqual([]);
    }
  });

  it('rejects an out-of-vocabulary dimension / severity / effort', () => {
    expect(scanFindingSchema.safeParse({ ...base, dimension: 'perf' }).success).toBe(false);
    expect(scanFindingSchema.safeParse({ ...base, severity: 'Critical' }).success).toBe(false);
    expect(scanFindingSchema.safeParse({ ...base, effort: 'Epic' }).success).toBe(false);
  });

  it('rejects confidence outside [0,1]', () => {
    expect(scanFindingSchema.safeParse({ ...base, confidence: 1.5 }).success).toBe(false);
  });
});

describe('ranking + ordering', () => {
  it('severityRank orders High→Low, unknown last', () => {
    expect(severityRank('High')).toBeLessThan(severityRank('Medium'));
    expect(severityRank('Medium')).toBeLessThan(severityRank('Low'));
    expect(severityRank('???')).toBeGreaterThan(severityRank('Low'));
  });

  it('effortRank orders cheap→expensive', () => {
    expect(effortRank('Trivial')).toBeLessThan(effortRank('Large'));
  });

  it('compareFindings: severity dominates, then cheapest effort floats up', () => {
    const highLarge = { ...base, id: 'a', severity: 'High' as const, effort: 'Large' as const };
    const highTrivial = { ...base, id: 'b', severity: 'High' as const, effort: 'Trivial' as const };
    const medTrivial = {
      ...base,
      id: 'c',
      severity: 'Medium' as const,
      effort: 'Trivial' as const,
    };
    const sorted = [medTrivial, highLarge, highTrivial].sort(compareFindings);
    expect(sorted.map((f) => f.id)).toEqual(['b', 'a', 'c']);
  });
});
