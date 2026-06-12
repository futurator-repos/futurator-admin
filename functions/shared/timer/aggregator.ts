// Timer Intelligence — Aggregator (Story 1.8.2)
// Reduces a flat list of TimerSlice objects into per-category totals.
//
// One responsibility: sum durationMs per TimerCategory.
// Consumed by: API route (Story 1.8.3), forensic export, and the cron
// timing-aggregator (Story 1.8.4 / Epic 1.9).

import type { TimerCategory, TimerSlice } from './types';

/** Per-category summary produced by aggregateByCategory. */
export interface CategorySummary {
  totalMs: number;
  count: number;
}

/** Result shape returned by aggregateByCategory. */
export interface AggregationResult {
  byCategory: Record<TimerCategory, CategorySummary>;
  /** Grand total of all slice durations (may exceed wall-clock for parallel jobs). */
  totalMs: number;
}

// All valid categories — used to seed zero-entries so every key is always present.
// PR-49 (2026-05-07) — added 'baseline-check' (was missing since PR-36) and
// 'tamper-check' (new in PR-49). Without these, the forensic JSON's
// `aggregate.byCategory` map didn't surface the new categories.
const ALL_CATEGORIES: TimerCategory[] = [
  'dev',
  'test-author',
  'test-execute',
  'review',
  'qa',
  'po',
  'architect',
  'baseline-check',
  'tamper-check',
  'compile',
  'merge-gate',
  'vqa-gate',
  'human-wait',
  'machine-wait',
  'git',
  'bootstrap',
  'fix',
  'idle',
  'unattributed',
];

/**
 * Aggregate a list of TimerSlice objects into per-category totals.
 *
 * Every category key is always present in the returned `byCategory` map
 * (with `totalMs: 0, count: 0` when no slices were classified there). This
 * guarantees callers can safely read `byCategory['unattributed'].totalMs`
 * without optional-chaining.
 *
 * @param slices - Output of sliceForJob or sliceForPlan. May include live
 *   (isLive: true) trailing slices for ongoing jobs — these are included in
 *   the totals.
 */
export function aggregateByCategory(slices: TimerSlice[]): AggregationResult {
  // Seed every category with zeros
  const byCategory = Object.fromEntries(
    ALL_CATEGORIES.map((cat) => [cat, { totalMs: 0, count: 0 }]),
  ) as Record<TimerCategory, CategorySummary>;

  let totalMs = 0;

  for (const slice of slices) {
    const cat = slice.category;
    const entry = byCategory[cat];
    if (entry) {
      entry.totalMs += slice.durationMs;
      entry.count += 1;
    }
    totalMs += slice.durationMs;
  }

  return { byCategory, totalMs };
}
