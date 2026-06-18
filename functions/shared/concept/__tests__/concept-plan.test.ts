import { describe, it, expect } from 'vitest';
import {
  shouldRunConceptRoute,
  gateForRigor,
  artifactPlanned,
  type ConceptPlan,
} from '../concept-plan';
import { conceptPlanSchema } from '../../schemas/concept-plan-schema';
import { buildConceptRoutePrompt } from '../../prompts/concept-route-prompt';
import { buildArchGenPrompt } from '../../prompts/arch-gen-prompt';
import { generateConceptRoutePipeline } from '../../pipelines/concept-route-pipeline';
import { generateArchGenPipeline } from '../../pipelines/arch-gen-pipeline';

/** Concept v2 — Story E7.1: the Router contract + prototype bypass (W8). */
describe('conceptPlan contract (Concept v2 — E7.1)', () => {
  it('W8 — prototype BYPASSES the Router; mvp/production run it', () => {
    expect(shouldRunConceptRoute({ rigor: 'prototype' })).toBe(false);
    expect(shouldRunConceptRoute({ rigor: 'mvp' })).toBe(true);
    expect(shouldRunConceptRoute({ rigor: 'production' })).toBe(true);
    expect(shouldRunConceptRoute({})).toBe(true); // absent rigor → not prototype
  });

  it('gateForRigor maps rigor → gate strictness', () => {
    expect(gateForRigor('prototype')).toBe('noop');
    expect(gateForRigor('mvp')).toBe('light');
    expect(gateForRigor('production')).toBe('strict');
  });

  it('artifactPlanned guards v2 branches on conceptPlan presence', () => {
    const plan: ConceptPlan = {
      uiBearing: false,
      complexity: 'low',
      artifacts: [{ kind: 'prd', depth: 'lite' }],
      gate: 'light',
      rationale: 'r',
    };
    expect(artifactPlanned(plan, 'prd')).toBe(true);
    expect(artifactPlanned(plan, 'ux')).toBe(false);
    expect(artifactPlanned(undefined, 'prd')).toBe(false); // prototype/legacy = absent
  });
});

describe('conceptPlanSchema (Concept v2 — E7.1)', () => {
  const uiPlan = {
    uiBearing: true,
    complexity: 'medium',
    artifacts: [
      { kind: 'prd', depth: 'full' },
      { kind: 'ux', depth: 'light', dependsOn: ['prd'] },
      { kind: 'architecture', depth: 'full', dependsOn: ['prd', 'ux'] },
    ],
    gate: 'strict',
    rationale: 'UI app with multiple subsystems.',
  };

  it('accepts a well-formed UI-bearing plan', () => {
    expect(conceptPlanSchema.safeParse(uiPlan).success).toBe(true);
  });

  it('rejects a uiBearing plan that omits ux (the v0.1 flaw)', () => {
    const bad = { ...uiPlan, artifacts: uiPlan.artifacts.filter((a) => a.kind !== 'ux') };
    expect(conceptPlanSchema.safeParse(bad).success).toBe(false);
  });

  it('rejects a non-uiBearing plan that includes ux', () => {
    const bad = { ...uiPlan, uiBearing: false };
    expect(conceptPlanSchema.safeParse(bad).success).toBe(false);
  });

  it('rejects a plan with no prd', () => {
    const bad = {
      ...uiPlan,
      uiBearing: false,
      artifacts: [{ kind: 'architecture', depth: 'full' }],
    };
    expect(conceptPlanSchema.safeParse(bad).success).toBe(false);
  });
});

describe('concept-route + arch-gen prompts & pipelines (Concept v2 — E7.1/E7.4)', () => {
  it('route prompt instructs UX-iff-uiBearing and emits the rigor-derived gate', () => {
    const p = buildConceptRoutePrompt({
      intent: 'a game',
      boilerplateType: 'nextjs-base',
      rigor: 'production',
    });
    expect(p).toContain('uiBearing');
    expect(p).toContain('UX applies iff uiBearing');
    expect(p).toContain('"gate": "strict"');
    expect(p).toContain('---CONCEPT_PLAN---');
  });

  it('route pipeline is a single classifier step extracting CONCEPT_PLAN_JSON', () => {
    const pipe = generateConceptRoutePipeline({
      intent: 'x',
      boilerplateType: 'nextjs-base',
      rigor: 'mvp',
    });
    expect(pipe.steps).toHaveLength(1);
    expect(pipe.steps[0].id).toBe('concept-route');
    expect(pipe.steps[0].extractors?.CONCEPT_PLAN_JSON).toBeDefined();
  });

  it('arch-gen prompt cites the UX spec only when uiBearing', () => {
    const ui = buildArchGenPrompt({ intent: 'x', rigor: 'mvp', depth: 'full', uiBearing: true });
    const cli = buildArchGenPrompt({ intent: 'x', rigor: 'mvp', depth: 'full', uiBearing: false });
    expect(ui).toContain('UX spec');
    expect(cli).toContain('No UI');
    expect(ui).toContain('---ARCHITECTURE_MD---');
  });

  it('arch-gen prompt renders ground-truth when provided (E7.5 hook)', () => {
    const grounded = buildArchGenPrompt({
      intent: 'x',
      rigor: 'mvp',
      depth: 'full',
      uiBearing: false,
      groundTruth: 'Table(PlansTable) READS by api/index.ts',
    });
    expect(grounded).toContain('Ground truth');
    expect(grounded).toContain('PlansTable');
  });

  it('arch-gen pipeline extracts ARCHITECTURE_MD', () => {
    const pipe = generateArchGenPipeline({
      intent: 'x',
      boilerplateType: 'nextjs-base',
      rigor: 'mvp',
      depth: 'full',
      uiBearing: true,
    });
    expect(pipe.steps[0].id).toBe('arch-gen');
    expect(pipe.steps[0].extractors?.ARCHITECTURE_MD).toBeDefined();
  });
});
