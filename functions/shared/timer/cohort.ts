// Timer Intelligence — Cohort math (Stories 1.8.6 + 1.8.7)
//
// Pure, side-effect-free helpers that are shared by:
//   • timing-aggregator.ts   (cron that writes TimingSummary rows)
//   • escalator.ts           (3× outlier detector)
//   • GET /api/timing/cohort (API route)
//
// No I/O in this file — all DDB access lives in timing-summary-repository.ts.

import type { TimerCategory } from './types';

// ── Epic-count bucketing ─────────────────────────────────────────────────────

/**
 * Map an epic count into the bucket key used as part of the cohort PK.
 *
 * Buckets capture ±25% variance (AC §1 formula):
 *   epicCount in [1, 2]  → bucket = 1
 *   epicCount in [3, 4]  → bucket = 3
 *   epicCount in [5, 6]  → bucket = 5
 *   …
 *
 * Formula: floor(epicCount / 2) * 2 + 1  (but clamped to 1 for epicCount=0)
 */
export function epicCountBucket(epicCount: number): number {
  if (epicCount <= 0) return 1;
  return Math.floor(epicCount / 2) * 2 + 1;
}

// ── cohortKey ────────────────────────────────────────────────────────────────

/**
 * Derive the cohort PK from plan and app fields.
 *
 * Format: `<templateType>#<planKind>#<epicCountBucket>`
 *
 * Example: `nextjs#initial#3`
 *
 * @param templateType  App.boilerplateType ?? 'nextjs'
 * @param planKind      Plan.kind ?? 'change'
 * @param epicCount     (plan.epicIds ?? []).length
 */
export function buildCohortKey(templateType: string, planKind: string, epicCount: number): string {
  return `${templateType}#${planKind}#${epicCountBucket(epicCount)}`;
}

// ── Statistical helpers ──────────────────────────────────────────────────────

/**
 * Compute the value at percentile `p` (0–1) from an array of numbers.
 * Array does NOT need to be pre-sorted — this function sorts internally.
 * Returns 0 for an empty array.
 */
export function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.ceil(sorted.length * p) - 1;
  return sorted[Math.max(0, Math.min(idx, sorted.length - 1))];
}

/** Median (p50) of an array. Returns 0 for empty. */
export function median(values: number[]): number {
  return percentile(values, 0.5);
}

/** P90 of an array. Returns 0 for empty. */
export function p90(values: number[]): number {
  return percentile(values, 0.9);
}

// ── Per-category aggregation across a cohort ─────────────────────────────────

/**
 * Shape of one per-category entry in a TimingSummary row.
 * Carries median + P90 across plans, plus slice count (for weighting later).
 */
export interface CohortCategoryStats {
  medianMs: number;
  p90Ms: number;
  count: number;
}

/**
 * Given a list of per-plan category totals (one number per plan, per category),
 * compute the cohort-level median and P90 for each category.
 *
 * @param planCategoryTotals  Array of {category → totalMs} objects, one per plan.
 * @param planCategoryCountss Array of {category → sliceCount} objects (same length).
 * @returns Record<TimerCategory, CohortCategoryStats>
 */
export function computeCohortByCategory(
  planCategoryTotals: Array<Partial<Record<TimerCategory, number>>>,
  planCategoryCounts: Array<Partial<Record<TimerCategory, number>>>,
): Record<TimerCategory, CohortCategoryStats> {
  // Collect all category names across all plans
  const allCats = new Set<TimerCategory>();
  for (const totals of planCategoryTotals) {
    for (const cat of Object.keys(totals) as TimerCategory[]) {
      allCats.add(cat);
    }
  }

  const result: Partial<Record<TimerCategory, CohortCategoryStats>> = {};

  for (const cat of allCats) {
    const msList: number[] = [];
    let totalCount = 0;

    for (let i = 0; i < planCategoryTotals.length; i++) {
      const ms = planCategoryTotals[i][cat] ?? 0;
      const cnt = planCategoryCounts[i]?.[cat] ?? 0;
      msList.push(ms);
      totalCount += cnt;
    }

    result[cat] = {
      medianMs: median(msList),
      p90Ms: p90(msList),
      count: totalCount,
    };
  }

  return result as Record<TimerCategory, CohortCategoryStats>;
}
