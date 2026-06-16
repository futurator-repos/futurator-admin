import type { Plan } from '../types/plan';
import type { AgentJob } from '../types/agent-orchestrator';
import { conceptPlanSchema, type ConceptPlanOutput } from '../schemas/concept-plan-schema';
import { seedConceptArtifacts } from '../concept/artifact-version';

/**
 * Concept v2 (integration) — apply a Concept Router job's `CONCEPT_PLAN_JSON`
 * output to the Plan row. The exact sibling of `plan-generation-service`'s
 * parse/validate/apply funnel (PLAN_JSON), reused by the
 * `POST /api/plans/:id/apply-concept-plan` endpoint. The daemon runs the
 * `concept-route` job (E7.1) and captures CONCEPT_PLAN_JSON into job.variables;
 * this turns that into a validated `plan.conceptPlan`.
 */

export interface ConceptRouteDeps {
  updatePlanFields: (planId: string, patch: Partial<Plan>) => Promise<void>;
}

/** Parse + validate the CONCEPT_PLAN_JSON captured in a completed concept-route job. */
export function parseConceptRouteOutput(job: AgentJob): ConceptPlanOutput {
  const raw = job.variables?.CONCEPT_PLAN_JSON;
  if (!raw) {
    throw new Error(
      'Job has no CONCEPT_PLAN_JSON variable — Concept Router did not emit the expected fenced output.',
    );
  }
  const cleaned = raw
    .replace(/---CONCEPT_PLAN---/g, '')
    .replace(/---END_CONCEPT_PLAN---/g, '')
    .replace(/^```(?:json)?\s*/im, '')
    .replace(/\s*```\s*$/im, '')
    .trim();

  let parsed: unknown;
  try {
    parsed = JSON.parse(cleaned);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(
      `CONCEPT_PLAN_JSON is not valid JSON: ${message}. Raw: ${raw.slice(0, 200)}...`,
    );
  }
  return validateConceptPlanJson(parsed);
}

/** Single validation funnel for a parsed conceptPlan value (router-job + import paths). */
export function validateConceptPlanJson(parsed: unknown): ConceptPlanOutput {
  const result = conceptPlanSchema.safeParse(parsed);
  if (!result.success) {
    const issues = result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new Error(`CONCEPT_PLAN_JSON fails schema: ${issues}`);
  }
  return result.data;
}

/**
 * Persist the validated conceptPlan on the Plan row AND seed the per-artifact
 * version registry (E1.1) from its applicability DAG — one `draft/rev:0` row per
 * planned artifact, `dependsOn` copied. Idempotent: re-applying the same router
 * output re-seeds the same genesis rows (apply runs before any generator bumps a
 * rev), so cron replay is a no-op. Generators later advance each row via the
 * apply-service (E1.3); we never clobber a row that already carries `rev>0`.
 */
export async function applyConceptRouteOutput(
  plan: Plan,
  conceptPlan: ConceptPlanOutput,
  deps: ConceptRouteDeps,
): Promise<void> {
  const alreadyStarted = (plan.conceptArtifacts ?? []).some((a) => a.rev > 0);
  const patch: Partial<Plan> = { conceptPlan };
  // Only seed when no generator has advanced a row yet — preserves real
  // rev/contentHash/status if the router output is (re-)applied post-generation.
  if (!alreadyStarted) {
    patch.conceptArtifacts = seedConceptArtifacts(conceptPlan.artifacts);
  }
  await deps.updatePlanFields(plan.planId, patch);
}
