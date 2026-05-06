import { describe, it, expect } from 'vitest';
import { defaultCostCeiling, COST_CEILING_BY_RIGOR } from '../cost-ceiling-defaults';

describe('PR-45 — defaultCostCeiling', () => {
  it('matches the dashboard BUDGET WARNING banner thresholds (Phase 2-A §F-5)', () => {
    expect(defaultCostCeiling('prototype')).toBe(5);
    expect(defaultCostCeiling('mvp')).toBe(20);
    expect(defaultCostCeiling('production')).toBe(50);
  });

  it('COST_CEILING_BY_RIGOR is exhaustive over PlanRigor', () => {
    expect(Object.keys(COST_CEILING_BY_RIGOR).sort()).toEqual(['mvp', 'production', 'prototype']);
  });

  it('every rigor maps to a positive number', () => {
    for (const ceiling of Object.values(COST_CEILING_BY_RIGOR)) {
      expect(ceiling).toBeGreaterThan(0);
      expect(Number.isFinite(ceiling)).toBe(true);
    }
  });

  it('prototype < mvp < production (monotonic)', () => {
    expect(COST_CEILING_BY_RIGOR.prototype).toBeLessThan(COST_CEILING_BY_RIGOR.mvp);
    expect(COST_CEILING_BY_RIGOR.mvp).toBeLessThan(COST_CEILING_BY_RIGOR.production);
  });
});
