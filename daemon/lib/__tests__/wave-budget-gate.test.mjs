/**
 * wave-budget-gate.test.mjs — F6 (P0 cost safety).
 *
 * The wave-boundary HARD cost gate (agent-daemon.mjs::enforceWaveBudgetGate)
 * reuses the EXISTING cost-meter decision math: it calls
 * `CostMeter.decideAction(totalCostUsd, ceiling * (1 + TOLERANCE))` and treats
 * `action === 'terminate'` as the hard stop. This test pins that semantics —
 * spend is allowed up to ceiling + tolerance, then hard-stops — so the gate
 * can't silently regress (e.g. a refactor of decideAction's thresholds).
 */

import { describe, it, expect } from 'vitest';
import { CostMeter } from '../cost-meter.mjs';

// Must match WAVE_BUDGET_OVERRUN_TOLERANCE in agent-daemon.mjs.
const TOLERANCE = 0.05;

/** Mirror of the gate's decision: blocked iff decideAction terminates. */
function isBlocked(totalUsd, ceilingUsd) {
  if (!Number.isFinite(ceilingUsd) || ceilingUsd <= 0) return false;
  const decision = new CostMeter({}).decideAction(totalUsd, ceilingUsd * (1 + TOLERANCE));
  return decision.action === 'terminate';
}

describe('F6 wave budget gate semantics', () => {
  it('does not block when no ceiling is set (back-compat)', () => {
    expect(isBlocked(9999, undefined)).toBe(false);
    expect(isBlocked(9999, 0)).toBe(false);
    expect(isBlocked(9999, NaN)).toBe(false);
  });

  it('does not block when spend is under the ceiling', () => {
    expect(isBlocked(10, 20)).toBe(false);
    expect(isBlocked(19.99, 20)).toBe(false);
  });

  it('allows a small overrun within tolerance', () => {
    // ceiling 20, tolerance 5% → hard stop only at >= 21.
    expect(isBlocked(20.5, 20)).toBe(false);
    expect(isBlocked(20.99, 20)).toBe(false);
  });

  it('hard-blocks once spend passes ceiling + tolerance', () => {
    expect(isBlocked(21, 20)).toBe(true);
    expect(isBlocked(50, 20)).toBe(true);
  });
});
