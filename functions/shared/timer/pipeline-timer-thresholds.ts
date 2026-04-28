// Timer Intelligence — Threshold config (Story 1.8.6 AC §6)
//
// Single source of truth for escalator trigger ratios and cohort min-samples.
// Imported by: escalator.ts, timing-aggregator.ts, GET /api/timing/cohort.

/**
 * Threshold multipliers for the 3× escalator (Story 1.8.7).
 *
 * - `info`:       category time ≥ 3.0× cohort median  → info-severity attention item
 * - `medium`:     category time ≥ 5.0× cohort median  → medium-severity attention item
 * - `minSamples`: cohort must have at least this many plans before escalation fires.
 *                 Below this floor the cohort is statistically useless.
 */
export const THRESHOLDS = {
  info: 3.0,
  medium: 5.0,
  minSamples: 5,
} as const;
