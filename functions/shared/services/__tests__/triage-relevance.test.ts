/**
 * triage-relevance.test.ts — Pipeline v2 Phase 3 / Story 3-E-6-1 (PR-81).
 */

import { describe, it, expect } from 'vitest';
import {
  classifyMatchTier,
  computeRelevance,
  topRelevant,
  MATCH_MODIFIERS,
  NOT_RELEVANT_DECAY,
} from '../triage-relevance';

const FAMILIES = {
  songster: new Set(['songster-main', 'songster-live-perf']),
};

describe('classifyMatchTier', () => {
  it('same project → same-project', () => {
    expect(classifyMatchTier('dino', 'dino')).toBe('same-project');
  });

  it('same family → same-family', () => {
    expect(classifyMatchTier('songster-main', 'songster-live-perf', FAMILIES)).toBe('same-family');
  });

  it('different projects no family → cross-product', () => {
    expect(classifyMatchTier('dino', 'songster-main', FAMILIES)).toBe('cross-product');
  });

  it('no families map provided → cross-product (excluding same-project)', () => {
    expect(classifyMatchTier('a', 'b')).toBe('cross-product');
  });

  it('family map with array values works', () => {
    const tier = classifyMatchTier('a', 'b', { fam: ['a', 'b'] });
    expect(tier).toBe('same-family');
  });
});

describe('MATCH_MODIFIERS sanity', () => {
  it('mirrors v2.5 §43 table', () => {
    expect(MATCH_MODIFIERS['same-project']).toBe(1.0);
    expect(MATCH_MODIFIERS['same-family']).toBe(0.7);
    expect(MATCH_MODIFIERS['cross-product']).toBe(0.4);
  });
});

describe('computeRelevance', () => {
  it('same project: score = baseSimilarity', () => {
    const result = computeRelevance({
      baseSimilarity: 0.8,
      sourceProject: 'dino',
      targetProject: 'dino',
    });
    expect(result.score).toBe(0.8);
    expect(result.tier).toBe('same-project');
    expect(result.modifier).toBe(1.0);
    expect(result.decayed).toBe(false);
  });

  it('same family: score = baseSimilarity × 0.7', () => {
    const result = computeRelevance({
      baseSimilarity: 0.8,
      sourceProject: 'songster-main',
      targetProject: 'songster-live-perf',
      productFamilies: FAMILIES,
    });
    expect(result.score).toBeCloseTo(0.56);
    expect(result.tier).toBe('same-family');
  });

  it('cross-product: score = baseSimilarity × 0.4', () => {
    const result = computeRelevance({
      baseSimilarity: 0.8,
      sourceProject: 'dino',
      targetProject: 'songster-main',
    });
    expect(result.score).toBeCloseTo(0.32);
    expect(result.tier).toBe('cross-product');
  });

  it('declined pair applies NOT_RELEVANT_DECAY', () => {
    const result = computeRelevance({
      baseSimilarity: 0.8,
      sourceProject: 'dino',
      targetProject: 'dino',
      sourceCaseId: 'S1',
      targetCaseId: 'T1',
      declinedPairs: new Set(['S1::T1']),
    });
    expect(result.decayed).toBe(true);
    expect(result.score).toBeCloseTo(0.8 * NOT_RELEVANT_DECAY);
  });

  it('does not apply decay when case ids missing', () => {
    const result = computeRelevance({
      baseSimilarity: 0.8,
      sourceProject: 'dino',
      targetProject: 'dino',
      declinedPairs: new Set(['S1::T1']),
    });
    expect(result.decayed).toBe(false);
  });

  it('throws on baseSimilarity outside [0,1]', () => {
    expect(() =>
      computeRelevance({
        baseSimilarity: 1.5,
        sourceProject: 'a',
        targetProject: 'b',
      }),
    ).toThrow(/in \[0,1\]/);
    expect(() =>
      computeRelevance({
        baseSimilarity: -0.1,
        sourceProject: 'a',
        targetProject: 'b',
      }),
    ).toThrow();
  });
});

describe('topRelevant', () => {
  it('returns top 3 by default, descending', () => {
    const candidates = [
      {
        case: 'A',
        relevance: { score: 0.2, tier: 'cross-product', modifier: 0.4, decayed: false },
      },
      { case: 'B', relevance: { score: 0.9, tier: 'same-project', modifier: 1.0, decayed: false } },
      { case: 'C', relevance: { score: 0.5, tier: 'same-family', modifier: 0.7, decayed: false } },
      { case: 'D', relevance: { score: 0.7, tier: 'same-project', modifier: 1.0, decayed: false } },
    ] as const;
    const top = topRelevant({ candidates });
    expect(top.map((t) => t.case)).toEqual(['B', 'D', 'C']);
  });

  it('respects custom limit', () => {
    const candidates = [
      { case: 'A', relevance: { score: 0.9, tier: 'same-project', modifier: 1, decayed: false } },
      { case: 'B', relevance: { score: 0.5, tier: 'same-project', modifier: 1, decayed: false } },
    ] as const;
    expect(topRelevant({ candidates, limit: 1 })).toHaveLength(1);
  });
});
