// cost-tracker — an immutable spend accumulator (development-plan §5.4).
//
// ecc's CostTracker pattern: spend is append-only and the object is frozen, so a
// budget value can never be silently mutated out from under a gate decision.
// `.add()` returns a NEW tracker; the original is unchanged. This is the value
// the hard ceiling is decided against once the harness-cost bridge has
// reconciled the true per-process spend into it.

const round = (n) => Math.round((Number(n) || 0) * 1e6) / 1e6;

/**
 * @param {number} usd        spend so far
 * @param {number|null} ceiling  hard ceiling (null = no ceiling)
 * @param {number} warnAt     fraction of ceiling that trips a warning (default 0.8)
 */
export function createCostTracker(usd = 0, ceiling = null, warnAt = 0.8) {
  const spend = round(Math.max(0, usd));
  const cap = ceiling == null ? null : round(ceiling);

  const self = {
    usd: spend,
    ceiling: cap,
    warnAt,
    /** Return a NEW tracker with `delta` added. Never mutates. */
    add(delta) {
      return createCostTracker(spend + round(delta), cap, warnAt);
    },
    /** Replace the absolute spend (used after a bridge reconcile). New tracker. */
    withSpend(absolute) {
      return createCostTracker(absolute, cap, warnAt);
    },
    /** True once spend reaches or passes the ceiling. */
    overBudget() {
      return cap != null && spend >= cap;
    },
    /** True once spend reaches the warn fraction of the ceiling (but not yet over). */
    warnThreshold() {
      return cap != null && spend >= cap * warnAt && spend < cap;
    },
    /** Remaining headroom (Infinity when no ceiling). */
    remaining() {
      return cap == null ? Infinity : round(Math.max(0, cap - spend));
    },
    /** Fraction of ceiling consumed (0 when no ceiling). */
    fraction() {
      return cap == null || cap === 0 ? 0 : round(spend / cap);
    },
  };
  return Object.freeze(self);
}
