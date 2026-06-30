// cost-reconcile-gate — feed the TRUE spend into the wave budget gate
// (development-plan §5.4). The enforce-time half of the ~10× under-report fix.
//
// The legacy wave gate compares planRow.totalCostUsd (orchestrator-only, ~10×
// low) against the ceiling. This reconciles every process's authoritative spend
// (harness-cost bridge) and, depending on mode:
//   • observe  — logs the gap, returns the INTERNAL total (gate unchanged) so the
//     operator can recalibrate the baseline before enforcing;
//   • enforce  — returns max(internal, reconciled) as the effective total, so the
//     ceiling fires on real spend.
// Pure decision (`decideWaveBudget`) + the reconcile orchestration. Fail-open:
// a reconcile error returns the internal total (never harder than legacy).

import { reconcile, reconcileGap } from './harness-cost-bridge.mjs';
import { createCostTracker } from './cost-tracker.mjs';

const DEFAULT_TOLERANCE = 0.05; // matches the daemon's WAVE_BUDGET_OVERRUN_TOLERANCE

/** Pure: does `total` breach `ceiling` (inflated by tolerance)? */
export function decideWaveBudget({ total, ceiling, tolerance = DEFAULT_TOLERANCE }) {
  if (!Number.isFinite(ceiling) || ceiling <= 0) return { action: 'allow', over: false };
  const tracker = createCostTracker(total, ceiling * (1 + tolerance));
  if (tracker.overBudget()) return { action: 'block', over: true, fraction: tracker.fraction() };
  if (tracker.warnThreshold()) return { action: 'warn', over: false, fraction: tracker.fraction() };
  return { action: 'allow', over: false, fraction: tracker.fraction() };
}

/**
 * Reconcile harness-cost and decide the wave budget.
 *
 * @param {{
 *   harnessCostDir?: string, sessionIds?: string[],
 *   internalTotalUsd: number, ceilingUsd: number,
 *   mode: 'off'|'observe'|'enforce', tolerance?: number,
 *   log?: (level,msg)=>void,
 * }} args
 * @returns {{ reconciledUsd:number, effectiveTotal:number, gap:object, decision:object, mode:string }}
 */
export function reconcileWaveCost({
  harnessCostDir, sessionIds, internalTotalUsd = 0, ceilingUsd,
  mode = 'off', tolerance = DEFAULT_TOLERANCE, log = () => {},
}) {
  let reconciledUsd = 0;
  try {
    reconciledUsd = reconcile({ dir: harnessCostDir, sessionIds: sessionIds || null }).totalUsd;
  } catch {
    reconciledUsd = 0; // fail-open
  }
  const gap = reconcileGap(internalTotalUsd, reconciledUsd);

  // off → no change. observe → log the gap, keep internal. enforce → use the max.
  const effectiveTotal = mode === 'enforce' ? Math.max(internalTotalUsd, reconciledUsd) : internalTotalUsd;

  if (mode !== 'off' && gap.ratio && gap.ratio > 1.5) {
    log('warn', `[cost-reconcile] internal $${gap.internal.toFixed(2)} vs reconciled $${gap.real.toFixed(2)} (${gap.ratio}× under-report)`);
  }

  const decision = decideWaveBudget({ total: effectiveTotal, ceiling: ceilingUsd, tolerance });
  return { reconciledUsd, effectiveTotal, gap, decision, mode };
}
