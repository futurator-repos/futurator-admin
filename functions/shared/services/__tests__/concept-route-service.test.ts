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
    const updatePlanFields = vi.fn(async () => {});
    const plan = { planId: 'plan-1' } as Plan;
    await applyConceptRouteOutput(plan, validateConceptPlanJson(VALID), { updatePlanFields });
    expect(updatePlanFields).toHaveBeenCalledWith('plan-1', {
      conceptPlan: expect.objectContaining({ uiBearing: true, gate: 'strict' }),
    });
  });
});
