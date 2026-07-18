/**
 * Deploy gate — the pure "can this plan promote?" rule for DeployView (design
 * doc I2 slice A5 / U5).
 *
 * Kept separate from the view component (no React import) so it's trivially
 * unit-testable and can be reused by any future promote-adjacent surface
 * without dragging JSX along.
 */

import type { Plan } from '@/types/plan';
import type { QaReadiness } from '@/hooks/use-p3-qa-report';

export interface PromoteGate {
  canPromote: boolean;
  /** Human-readable reason the ladder is blocked — always present when canPromote is false. */
  reason?: string;
}

/** The minimal plan-ish shape the gate needs. */
export type PromoteGateInput = Pick<Plan, 'devUrl'> | null | undefined;

/**
 * Ladder gate for the top-level promote CTA (ReleaseStrip's `canDeploy` /
 * `blockedReason`). Per-rung gating (dev→staging vs staging→production) still
 * lives server-side on `DeployEnvironmentStatus.canPromote` — this is the
 * coarser "is there anything to promote at all" check surfaced above the
 * ladder, so the operator sees WHY before hunting for a disabled button.
 *
 *   no plan loaded  → blocked
 *   no dev deploy   → blocked ("deploy to dev first")
 *   QA not verified → blocked ("QA blocking" / "QA not verified yet")
 *   otherwise       → allowed
 */
export function canPromote(plan: PromoteGateInput, readiness: QaReadiness): PromoteGate {
  if (!plan) {
    return { canPromote: false, reason: 'Plan not loaded yet.' };
  }
  if (!plan.devUrl) {
    return { canPromote: false, reason: 'No dev deploy yet — deploy to dev before promoting.' };
  }
  if (readiness === 'blocking') {
    return {
      canPromote: false,
      reason: 'QA is blocking — resolve the failing journeys/VQA before promoting.',
    };
  }
  if (readiness === 'pending') {
    return {
      canPromote: false,
      reason: 'QA has not verified this commit yet — run QA before promoting.',
    };
  }
  return { canPromote: true };
}
