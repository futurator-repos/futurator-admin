import { describe, it, expect } from 'vitest';
import { reduceConcept } from '../concept-reducer';
import type { ConceptArtifact } from '../../concept/artifact-version';
import type { ConceptPlan } from '../../concept/concept-plan';
import type { Plan } from '../../types/plan';

function art(
  kind: ConceptArtifact['kind'],
  status: ConceptArtifact['status'],
  rev: number,
  dependsOn: ConceptArtifact['dependsOn'] = [],
): ConceptArtifact {
  return { kind, status, rev, dependsOn, contentHash: rev > 0 ? `sha256:${kind}` : '' };
}

const UI_PLAN: ConceptPlan = {
  uiBearing: true,
  complexity: 'medium',
  gate: 'light',
  rationale: 'ui app',
  artifacts: [
    { kind: 'prd', depth: 'light' },
    { kind: 'ux', depth: 'light', dependsOn: ['prd'] },
    { kind: 'architecture', depth: 'full', dependsOn: ['prd', 'ux'] },
  ],
};

const NONUI_PLAN: ConceptPlan = {
  uiBearing: false,
  complexity: 'low',
  gate: 'light',
  rationale: 'cli',
  artifacts: [
    { kind: 'prd', depth: 'light' },
    { kind: 'architecture', depth: 'full', dependsOn: ['prd'] },
  ],
};

function plan(
  conceptPlan: ConceptPlan | undefined,
  conceptArtifacts: ConceptArtifact[],
  conceptInteraction: Plan['conceptInteraction'] = 'autopilot',
): Plan {
  return { conceptPlan, conceptArtifacts, conceptInteraction, rigor: 'mvp' } as unknown as Plan;
}

describe('reduceConcept (Story 3.1 — next-artifact selection)', () => {
  it('prototype / no conceptPlan → noop (v1 path untouched, W8)', () => {
    expect(reduceConcept(plan(undefined, []))).toMatchObject({ type: 'noop' });
  });

  it('fresh seeded registry → enqueue the first artifact (prd)', () => {
    const a = [
      art('prd', 'draft', 0),
      art('ux', 'draft', 0, ['prd']),
      art('architecture', 'draft', 0, ['prd', 'ux']),
    ];
    expect(reduceConcept(plan(UI_PLAN, a))).toMatchObject({
      type: 'enqueue-artifact',
      kind: 'prd',
    });
  });

  it('[prd approved, ux draft depsOn prd] → enqueue ux next', () => {
    const a = [
      art('prd', 'approved', 1),
      art('ux', 'draft', 0, ['prd']),
      art('architecture', 'draft', 0, ['prd', 'ux']),
    ];
    expect(reduceConcept(plan(UI_PLAN, a))).toMatchObject({ type: 'enqueue-artifact', kind: 'ux' });
  });

  it('[prd+ux approved, arch draft depsOn prd,ux] → enqueue arch next', () => {
    const a = [
      art('prd', 'approved', 1),
      art('ux', 'approved', 1, ['prd']),
      art('architecture', 'draft', 0, ['prd', 'ux']),
    ];
    expect(reduceConcept(plan(UI_PLAN, a))).toMatchObject({
      type: 'enqueue-artifact',
      kind: 'architecture',
    });
  });

  it('all artifacts approved → enqueue-pm-plan', () => {
    const a = [
      art('prd', 'approved', 1),
      art('ux', 'approved', 1, ['prd']),
      art('architecture', 'approved', 1, ['prd', 'ux']),
    ];
    expect(reduceConcept(plan(UI_PLAN, a))).toEqual({ type: 'enqueue-pm-plan' });
  });

  it('non-UI plan (no ux) → prd then arch then pm-plan', () => {
    const fresh = [art('prd', 'draft', 0), art('architecture', 'draft', 0, ['prd'])];
    expect(reduceConcept(plan(NONUI_PLAN, fresh))).toMatchObject({ kind: 'prd' });
    const prdDone = [art('prd', 'approved', 1), art('architecture', 'draft', 0, ['prd'])];
    expect(reduceConcept(plan(NONUI_PLAN, prdDone))).toMatchObject({ kind: 'architecture' });
    const allDone = [art('prd', 'approved', 1), art('architecture', 'approved', 1, ['prd'])];
    expect(reduceConcept(plan(NONUI_PLAN, allDone))).toEqual({ type: 'enqueue-pm-plan' });
  });

  it('interactive + a drafted-but-not-approved artifact (rev>0) → awaiting-approval (blocks dependents)', () => {
    const a = [
      art('prd', 'draft', 1),
      art('ux', 'draft', 0, ['prd']),
      art('architecture', 'draft', 0, ['prd', 'ux']),
    ];
    expect(reduceConcept(plan(UI_PLAN, a, 'interactive'))).toEqual({
      type: 'awaiting-approval',
      kind: 'prd',
    });
  });

  it('autopilot + a drafted prd (rev>0, not yet approved) → still enqueue (no human gate)', () => {
    // In autopilot the apply path auto-approves; if the reducer sees a transient
    // draft it does not block on a human (that would wedge the DAG).
    const a = [art('prd', 'draft', 1), art('ux', 'draft', 0, ['prd'])];
    expect(reduceConcept(plan(UI_PLAN, a, 'autopilot'))).toMatchObject({
      type: 'enqueue-artifact',
      kind: 'prd',
    });
  });

  it('stale upstream re-activates: [prd approved, arch stale] → re-enqueue arch', () => {
    const a = [
      art('prd', 'approved', 1),
      art('ux', 'approved', 1, ['prd']),
      art('architecture', 'stale', 2, ['prd', 'ux']),
    ];
    expect(reduceConcept(plan(UI_PLAN, a))).toMatchObject({
      type: 'enqueue-artifact',
      kind: 'architecture',
    });
  });

  it('carries the resolved interaction on enqueue-artifact actions', () => {
    const a = [art('prd', 'draft', 0)];
    const res = reduceConcept(plan(NONUI_PLAN, a, 'interactive'));
    expect(res).toMatchObject({ type: 'enqueue-artifact', interaction: 'interactive' });
  });

  it('empty artifacts list on the conceptPlan → noop', () => {
    const emptyPlan = { ...UI_PLAN, artifacts: [] };
    expect(reduceConcept(plan(emptyPlan, []))).toMatchObject({ type: 'noop' });
  });
});
