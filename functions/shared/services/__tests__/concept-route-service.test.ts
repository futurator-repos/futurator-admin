import { describe, it, expect, vi } from 'vitest';
import {
  parseConceptRouteOutput,
  validateConceptPlanJson,
  applyConceptRouteOutput,
} from '../concept-route-service';
import type { AgentJob } from '../../types/agent-orchestrator';
import type { Plan } from '../../types/plan';

const VALID = {
  uiBearing: true,
  complexity: 'medium',
  artifacts: [
    { kind: 'prd', depth: 'full' },
    { kind: 'ux', depth: 'light', dependsOn: ['prd'] },
    { kind: 'architecture', depth: 'full', dependsOn: ['prd', 'ux'] },
  ],
  gate: 'strict',
  rationale: 'UI app, multiple subsystems.',
};

function job(vars: Record<string, string>): AgentJob {
  return {
    jobId: 'job-1',
    status: 'COMPLETED',
    createdAt: 't',
    updatedAt: 't',
    createdBy: 'tester',
    workingDir: '/tmp',
    variables: vars,
  } as unknown as AgentJob;
}

describe('concept-route-service (Concept v2 integration)', () => {
  it('parses a fenced CONCEPT_PLAN_JSON (fence markers tolerated)', () => {
    const raw = `---CONCEPT_PLAN---\n${JSON.stringify(VALID)}\n---END_CONCEPT_PLAN---`;
    const out = parseConceptRouteOutput(job({ CONCEPT_PLAN_JSON: raw }));
    expect(out.uiBearing).toBe(true);
    expect(out.artifacts.map((a) => a.kind)).toEqual(['prd', 'ux', 'architecture']);
  });

  it('throws when the job has no CONCEPT_PLAN_JSON variable', () => {
    expect(() => parseConceptRouteOutput(job({}))).toThrow(/no CONCEPT_PLAN_JSON/);
  });

  it('throws on non-JSON', () => {
    expect(() => parseConceptRouteOutput(job({ CONCEPT_PLAN_JSON: 'not json' }))).toThrow(
      /not valid JSON/,
    );
  });

  it('rejects a uiBearing plan missing ux (schema refinement surfaces)', () => {
    const bad = { ...VALID, artifacts: VALID.artifacts.filter((a) => a.kind !== 'ux') };
    expect(() => validateConceptPlanJson(bad)).toThrow(/fails schema/);
  });

  it('applies the validated conceptPlan via updatePlanFields', async () => {
    const updatePlanFields = vi.fn(async (_id: string, _patch: Partial<Plan>) => {});
    const plan = { planId: 'plan-1' } as Plan;
    await applyConceptRouteOutput(plan, validateConceptPlanJson(VALID), { updatePlanFields });
    expect(updatePlanFields).toHaveBeenCalledWith('plan-1', {
      conceptPlan: expect.objectContaining({ uiBearing: true, gate: 'strict' }),
      conceptArtifacts: expect.any(Array),
    });
  });

  // ── Story 1.1 — seed the version registry from the applicability DAG ──
  it('seeds one draft/rev:0 conceptArtifact per planned artifact, dependsOn copied', async () => {
    const updatePlanFields = vi.fn(async (_id: string, _patch: Partial<Plan>) => {});
    const plan = { planId: 'plan-1' } as Plan;
    await applyConceptRouteOutput(plan, validateConceptPlanJson(VALID), { updatePlanFields });
    const patch = updatePlanFields.mock.calls[0][1] as Partial<Plan>;
    expect(patch.conceptArtifacts).toEqual([
      { kind: 'prd', rev: 0, contentHash: '', status: 'draft', dependsOn: [] },
      { kind: 'ux', rev: 0, contentHash: '', status: 'draft', dependsOn: ['prd'] },
      {
        kind: 'architecture',
        rev: 0,
        contentHash: '',
        status: 'draft',
        dependsOn: ['prd', 'ux'],
      },
    ]);
  });

  it('seeds NO ux row for a non-UI plan (prd + arch only)', async () => {
    const updatePlanFields = vi.fn(async (_id: string, _patch: Partial<Plan>) => {});
    const nonUi = {
      ...VALID,
      uiBearing: false,
      artifacts: [
        { kind: 'prd', depth: 'full' },
        { kind: 'architecture', depth: 'full', dependsOn: ['prd'] },
      ],
    };
    await applyConceptRouteOutput({ planId: 'p' } as Plan, validateConceptPlanJson(nonUi), {
      updatePlanFields,
    });
    const patch = updatePlanFields.mock.calls[0][1] as Partial<Plan>;
    expect(patch.conceptArtifacts?.map((a) => a.kind)).toEqual(['prd', 'architecture']);
  });

  it('does NOT re-seed (clobber) a registry whose generators already advanced (rev>0)', async () => {
    const updatePlanFields = vi.fn(async (_id: string, _patch: Partial<Plan>) => {});
    const plan = {
      planId: 'plan-1',
      conceptArtifacts: [
        { kind: 'prd', rev: 2, contentHash: 'sha256:abc', status: 'approved', dependsOn: [] },
      ],
    } as unknown as Plan;
    await applyConceptRouteOutput(plan, validateConceptPlanJson(VALID), { updatePlanFields });
    const patch = updatePlanFields.mock.calls[0][1] as Partial<Plan>;
    expect(patch.conceptArtifacts).toBeUndefined();
    expect(patch.conceptPlan).toBeDefined();
  });
});
