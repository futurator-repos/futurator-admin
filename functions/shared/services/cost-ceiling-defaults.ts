import type { PlanRigor } from '../types/plan';

/**
 * Pipeline v2 Phase 2-A — Story 2-A-misc-2 / PR-45.
 *
 * Rigor-keyed default cost ceilings (USD). brick-breaker forensic
 * (`docs/concepts/logs/plan_brick-breaker_mou3l51l-forensic-review.md` §F-5)
 * showed a plan ran to $8.46 against an implicit $5 prototype budget with
 * no in-flight throttle — the cost-meter infrastructure existed
 * (`daemon/lib/cost-meter.mjs`) but `plan.costCeilingUsd` was never set
 * on creation, so the meter had no ceiling to compare against.
 *
 * Defaults match the dashboard's existing BUDGET WARNING banner thresholds:
 *   prototype  → $5    (cheap, fast, can run wide)
 *   mvp        → $20   (full inner-loop discipline; api-author + tests)
 *   production → $50   (full ceremony incl. PO/QA + 24h soak gate)
 *
 * The 80% warn-threshold lives in `cost-meter.mjs::decideAction` (warnAt=0.8)
 * — no need to duplicate here. The hard ceiling (1.0×) blocks new turns.
 *
 * Operators can override via `POST /api/plans/:id/raise-cost-ceiling`.
 */

export const COST_CEILING_BY_RIGOR: Record<PlanRigor, number> = {
  prototype: 5,
  mvp: 20,
  production: 50,
};

/**
 * Resolve the default cost ceiling for a plan based on its rigor.
 * Used by the three plan-create endpoints when the operator doesn't
 * supply an explicit `costCeilingUsd`.
 */
export function defaultCostCeiling(rigor: PlanRigor): number {
  return COST_CEILING_BY_RIGOR[rigor];
}
