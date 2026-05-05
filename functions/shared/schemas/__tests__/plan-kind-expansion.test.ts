import { describe, it, expect } from 'vitest';
import {
  planKindSchema,
  LEGACY_PLAN_KINDS,
  PHASE_2_PLAN_KINDS,
  NON_MAIN_PLAN_KINDS,
  SKIP_PO_QA_GATES_KINDS,
  isPlanKind,
} from '../plan-schema';
import type { PlanKind } from '../plan-schema';

describe('PR-39 — Plan.kind enum expansion (Story 2-A-7-1)', () => {
  it('accepts all 10 kinds (3 legacy + 7 Phase-2)', () => {
    const all: PlanKind[] = [...LEGACY_PLAN_KINDS, ...PHASE_2_PLAN_KINDS];
    expect(all).toHaveLength(10);
    for (const k of all) {
      expect(planKindSchema.safeParse(k).success, k).toBe(true);
    }
  });

  it('legacy kinds preserved (back-compat for App/Plan v1 rows)', () => {
    expect(LEGACY_PLAN_KINDS).toEqual(['initial', 'change', 'experiment']);
    for (const k of LEGACY_PLAN_KINDS) {
      expect(planKindSchema.safeParse(k).success).toBe(true);
    }
  });

  it('Phase-2 kinds match the v2.5 §5 enumeration', () => {
    expect(PHASE_2_PLAN_KINDS).toEqual([
      'feature',
      'bugfix',
      'maintenance',
      'prototype-on-top',
      'hotfix',
      'rigor-upgrade',
      'implementation-spec',
    ]);
  });

  it('rejects unknown kinds with a helpful zod error path', () => {
    const result = planKindSchema.safeParse('refactor');
    expect(result.success).toBe(false);
    if (!result.success) {
      // The Zod issue mentions 'Invalid enum value' or similar; just
      // verify it surfaces an issue rather than silently accepting.
      expect(result.error.issues.length).toBeGreaterThan(0);
    }
  });

  it('NON_MAIN_PLAN_KINDS covers experiment / prototype-on-top / hotfix', () => {
    expect(NON_MAIN_PLAN_KINDS).toEqual(['experiment', 'prototype-on-top', 'hotfix']);
    // Every non-main kind must be a valid PlanKind.
    for (const k of NON_MAIN_PLAN_KINDS) {
      expect(planKindSchema.safeParse(k).success).toBe(true);
    }
  });

  it('SKIP_PO_QA_GATES_KINDS only includes hotfix today', () => {
    expect(SKIP_PO_QA_GATES_KINDS).toEqual(['hotfix']);
  });

  it('isPlanKind narrows arbitrary strings correctly', () => {
    const a: unknown = 'feature';
    expect(isPlanKind(a)).toBe(true);
    if (isPlanKind(a)) {
      // TypeScript narrowing: a is PlanKind here.
      const k: PlanKind = a;
      expect(k).toBe('feature');
    }
    expect(isPlanKind('refactor')).toBe(false);
    expect(isPlanKind(42)).toBe(false);
    expect(isPlanKind(null)).toBe(false);
    expect(isPlanKind(undefined)).toBe(false);
  });

  it('hotfix kind branches off semver tag (per branch-namespace spec)', () => {
    // Encoded as a presence-check: the constant lists kinds that don't
    // branch off main. PR-44 / Phase 2-B-8 will use this to pick the
    // git-init branch base.
    expect(NON_MAIN_PLAN_KINDS).toContain('hotfix');
  });
});
