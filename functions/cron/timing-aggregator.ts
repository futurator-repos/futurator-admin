// Cron: Timing Aggregator — Story 1.8.6
//
// Runs every 6 hours. Scans all delivered Plans, groups them by cohortKey,
// computes median + P90 per category, and upserts one TimingSummary row per
// cohort that has ≥ THRESHOLDS.minSamples plans.
//
// Traversal: listApps() → listPlansByApp(appId) — reuses the same app+plan
// scan pattern as the inline cohort code in GET /api/timing/cohort.
//
// Phase-2 followup: once plan counts grow large, add a DDB GSI on
// `status + createdAt` so we can Query delivered plans directly without
// pulling all plans per app. For Phase 1 the full scan is acceptable.

import { listApps } from '../shared/repositories/app-repository';
import { listPlansByApp } from '../shared/repositories/plan-repository';
import { sliceForPlan } from '../shared/timer/slicer';
import { aggregateByCategory } from '../shared/timer/aggregator';
import { buildCohortKey, median, p90, computeCohortByCategory } from '../shared/timer/cohort';
import { upsertCohort } from '../shared/repositories/timing-summary-repository';
import { THRESHOLDS } from '../shared/timer/pipeline-timer-thresholds';
import { log } from '../shared/logger';
import type { TimerCategory } from '../shared/timer/types';
import type { TimingSummary } from '../shared/repositories/timing-summary-repository';

const TERMINAL_SUCCESS = new Set(['delivered']);
/** Maximum number of most-recent plans to sample per cohort. */
const MAX_SAMPLE_SIZE = 20;

export const handler = async (): Promise<void> => {
  const startTime = Date.now();
  log('info', 'timing-aggregator', 'Starting cohort aggregation');

  try {
    // ── 1. Collect all delivered plans grouped by cohortKey ──────────────────

    const apps = await listApps();

    // cohortKey → array of {planId, createdAt} sorted ascending
    const cohortPlanMap = new Map<
      string,
      Array<{ planId: string; createdAt: string; appId: string }>
    >();

    for (const app of apps) {
      // boilerplateType is typed as optional on App — default to 'nextjs' for legacy rows.
      const templateType: string = app.boilerplateType ?? 'nextjs';
      const plans = await listPlansByApp(app.appId);

      for (const plan of plans) {
        if (!TERMINAL_SUCCESS.has(plan.status)) continue;

        const epicCount = (plan.epicIds ?? []).length;
        // plan.kind is stored in DynamoDB but not yet typed on the Plan interface.
        // Cast safely; default to 'change' for legacy rows without this field.
        const planKind: string =
          ((plan as unknown as Record<string, unknown>).kind as string | undefined) ?? 'change';
        const cohortKey = buildCohortKey(templateType, planKind, epicCount);

        if (!cohortPlanMap.has(cohortKey)) {
          cohortPlanMap.set(cohortKey, []);
        }
        cohortPlanMap.get(cohortKey)!.push({
          planId: plan.planId,
          createdAt: plan.createdAt,
          appId: app.appId,
        });
      }
    }

    // ── 2. For each cohort with enough samples, compute stats and upsert ──────

    let cohortsWritten = 0;
    let cohortsSkipped = 0;

    for (const [cohortKey, allPlans] of cohortPlanMap) {
      const totalSamples = allPlans.length;

      if (totalSamples < THRESHOLDS.minSamples) {
        cohortsSkipped++;
        log('info', 'timing-aggregator', 'Cohort skipped — insufficient samples', {
          cohortKey,
          samples: totalSamples,
          minSamples: THRESHOLDS.minSamples,
        });
        continue;
      }

      // Take the most-recent MAX_SAMPLE_SIZE plans (descending by createdAt)
      const sorted = allPlans.slice().sort((a, b) => b.createdAt.localeCompare(a.createdAt));
      const sample = sorted.slice(0, MAX_SAMPLE_SIZE);

      // ── Compute timing for each sampled plan ─────────────────────────────
      // planTotalMs[i] = wall-clock duration of sample[i]
      const planTotalMs: number[] = [];
      // planCategoryTotals[i] = { category → attributed totalMs }
      const planCategoryTotals: Array<Partial<Record<TimerCategory, number>>> = [];
      // planCategoryCounts[i] = { category → slice count }
      const planCategoryCounts: Array<Partial<Record<TimerCategory, number>>> = [];
      const samplePlanIds: string[] = [];

      for (const { planId } of sample) {
        const slices = await sliceForPlan(planId);

        if (slices.length === 0) {
          // Skip plans with no events — can happen for legacy rows without events
          continue;
        }

        const agg = aggregateByCategory(slices);

        // Wall-clock duration (first → last slice timestamp)
        const firstMs = new Date(slices[0].startedAt).getTime();
        const lastMs = new Date(slices[slices.length - 1].endedAt).getTime();
        const durationMs = Math.max(0, lastMs - firstMs);

        planTotalMs.push(durationMs);

        const catTotals: Partial<Record<TimerCategory, number>> = {};
        const catCounts: Partial<Record<TimerCategory, number>> = {};
        for (const [cat, summary] of Object.entries(agg.byCategory) as Array<
          [TimerCategory, { totalMs: number; count: number }]
        >) {
          catTotals[cat] = summary.totalMs;
          catCounts[cat] = summary.count;
        }
        planCategoryTotals.push(catTotals);
        planCategoryCounts.push(catCounts);
        samplePlanIds.push(planId);
      }

      if (planTotalMs.length < THRESHOLDS.minSamples) {
        // After stripping zero-event plans, still not enough
        cohortsSkipped++;
        log(
          'info',
          'timing-aggregator',
          'Cohort skipped — insufficient valid samples after event check',
          {
            cohortKey,
            validSamples: planTotalMs.length,
          },
        );
        continue;
      }

      // ── Compute overall median + P90 ─────────────────────────────────────
      const overallMedianMs = median(planTotalMs);
      const overallP90Ms = p90(planTotalMs);

      // ── Compute per-category stats ────────────────────────────────────────
      const byCategory = computeCohortByCategory(planCategoryTotals, planCategoryCounts);

      const row: TimingSummary = {
        cohortKey,
        lastUpdated: new Date().toISOString(),
        samples: planTotalMs.length,
        medianMs: overallMedianMs,
        p90Ms: overallP90Ms,
        byCategory,
        lastSampleIds: samplePlanIds.slice(0, MAX_SAMPLE_SIZE),
      };

      await upsertCohort(row);
      cohortsWritten++;

      log('info', 'timing-aggregator', 'Cohort upserted', {
        cohortKey,
        samples: row.samples,
        medianMs: overallMedianMs,
        p90Ms: overallP90Ms,
      });
    }

    const duration = Date.now() - startTime;
    log('info', 'timing-aggregator', 'Completed', {
      appsScanned: apps.length,
      cohortsFound: cohortPlanMap.size,
      cohortsWritten,
      cohortsSkipped,
      duration,
    });
  } catch (error) {
    log('error', 'timing-aggregator', 'Failed', { error: String(error) });
    throw error;
  }
};
