// Timer Intelligence — 3× escalator (Story 1.8.7)
//
// Compares a delivered plan's per-category timing against the cohort baseline.
// Writes attention items for categories that exceed the configured ratio thresholds.
//
// Called fire-and-forget from wave-completion-check.ts after a plan is marked
// `delivered`. Never throws past the outer catch — all errors are logged.
//
// Export:
//   evaluateThresholds(planId) → Promise<{ itemsWritten: number }>

import { getPlanById } from '../repositories/plan-repository';
import { getApp } from '../repositories/app-repository';
import { getCohortByKey } from '../repositories/timing-summary-repository';
import { createAttentionItem } from '../repositories/attention-items-repository';
import { sliceForPlan } from './slicer';
import { aggregateByCategory } from './aggregator';
import { buildCohortKey } from './cohort';
import { THRESHOLDS } from './pipeline-timer-thresholds';
import { log } from '../logger';
import type { TimerCategory } from './types';
import type { AttentionItem } from '../types/attention';

// ── Category-specific operator hints ─────────────────────────────────────────

const CATEGORY_HINTS: Partial<Record<TimerCategory, string>> = {
  review: 'Review may be looping; check reviewer prompt or iteration cap',
  fix: 'DEV is iterating heavily; check for recurring test failures',
  'machine-wait': 'AWS step is slow; check Lambda cold starts or queue starvation',
  'merge-gate': 'Wave gate (merge + quality stages) is slow; check post-merge validation cost',
  'vqa-gate': 'Wave VQA (evidence/judges/fixer) is slow; check judge pool size and fix-cycle caps',
  'human-wait': 'Long human-wait; consider pre-resolving common attention triggers',
  dev: 'Dev exceeded cohort baseline; consider task decomposition',
};

const DEFAULT_HINT = "Category exceeded cohort baseline; review the plan's pipeline configuration";

function hintFor(cat: TimerCategory): string {
  return CATEGORY_HINTS[cat] ?? DEFAULT_HINT;
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Evaluate cohort thresholds for a delivered plan.
 *
 * Algorithm:
 *   1. Load plan + slice it.
 *   2. Determine cohortKey from plan's app + kind + epic count.
 *   3. Read TimingSummary for that cohortKey.
 *   4. If row missing or samples < THRESHOLDS.minSamples: no-op.
 *   5. For each category: ratio = planMs / cohortMedianMs.
 *      ratio ≥ THRESHOLDS.medium (5.0) → medium attention item.
 *      ratio ≥ THRESHOLDS.info   (3.0) → info attention item.
 *      (medium check runs first so we don't emit two items for the same category)
 *
 * Returns the count of attention items written.
 */
export async function evaluateThresholds(planId: string): Promise<{ itemsWritten: number }> {
  // ── Load plan ─────────────────────────────────────────────────────────────
  const plan = await getPlanById(planId);
  if (!plan) {
    log('warn', 'escalator', 'evaluateThresholds: plan not found', { planId });
    return { itemsWritten: 0 };
  }

  // ── Resolve app for boilerplateType ──────────────────────────────────────
  // Plan.appId is stored in DynamoDB (used by the GSI) but not yet typed on
  // the Plan interface. Cast to extract it safely; default to null if absent.
  const planRow = plan as unknown as Record<string, unknown>;
  const appId = (planRow.appId as string | undefined) ?? null;

  let templateType = 'nextjs';
  if (appId) {
    const app = await getApp(appId);
    if (app) {
      templateType = app.boilerplateType ?? 'nextjs';
    }
  }

  const planKind: string = (planRow.kind as string | undefined) ?? 'change';
  const epicCount = (plan.epicIds ?? []).length;

  const cohortKey = buildCohortKey(templateType, planKind, epicCount);

  // ── Load cohort baseline ──────────────────────────────────────────────────
  const cohort = await getCohortByKey(cohortKey);

  if (!cohort || cohort.samples < THRESHOLDS.minSamples) {
    log('info', 'escalator', 'No cohort or insufficient samples — skipping', {
      planId,
      cohortKey,
      samples: cohort?.samples ?? 0,
    });
    return { itemsWritten: 0 };
  }

  // ── Slice and aggregate the plan ──────────────────────────────────────────
  const slices = await sliceForPlan(planId);
  if (slices.length === 0) {
    return { itemsWritten: 0 };
  }
  const aggregate = aggregateByCategory(slices);

  // ── Compare each category vs cohort median ────────────────────────────────
  let itemsWritten = 0;
  const now = new Date().toISOString();

  const planLabel: string =
    (planRow.iterationLabel as string | undefined) ??
    (plan as { displayName?: string }).displayName ??
    plan.name;

  for (const [cat, summary] of Object.entries(aggregate.byCategory) as Array<
    [TimerCategory, { totalMs: number; count: number }]
  >) {
    const planMs = summary.totalMs;
    if (planMs <= 0) continue;

    const cohortCat = cohort.byCategory[cat];
    const cohortMedianMs = cohortCat?.medianMs ?? 0;
    if (cohortMedianMs <= 0) continue;

    const ratio = planMs / cohortMedianMs;

    // Determine severity — medium threshold takes precedence over info.
    // Maps to AttentionSeverity: 'info' (AC language) → 'low', 'medium' → 'medium'.
    let severity: 'low' | 'medium' | null = null;
    if (ratio >= THRESHOLDS.medium) {
      severity = 'medium';
    } else if (ratio >= THRESHOLDS.info) {
      severity = 'low'; // AC calls this 'info'; 'low' is the AttentionSeverity equivalent
    }

    if (!severity) continue;

    const item: AttentionItem = {
      planId,
      itemId: `${planId}#timer-outlier#${cat}#${now}`,
      createdAt: now,
      resolvedAt: null,
      severity,
      category: 'pv2-timer-cohort-outlier',
      title: `Plan ${planLabel}: ${cat} time ${ratio.toFixed(1)}× cohort median`,
      body: hintFor(cat),
      context: {},
      suggestedActions: [
        {
          label: 'View timing detail',
          kind: 'open-logs',
        },
      ],
      status: 'open',
      // Store escalator metadata in a non-typed extra field so the UI can
      // render the deep-link and sparkline. TypeScript-safe via the loose
      // AttentionItem shape (no excess-property check on object literal
      // passed to createAttentionItem which accepts AttentionItem).
      ...({
        deepLink: `/labs?planId=${planId}#timing`,
        metadata: {
          cat,
          ratio,
          planMs,
          cohortMedianMs,
          samples: cohort.samples,
        },
      } as unknown as Record<string, unknown>),
    };

    await createAttentionItem(item);
    itemsWritten++;

    log('info', 'escalator', 'Attention item written', {
      planId,
      cat,
      ratio: ratio.toFixed(2),
      severity,
      cohortKey,
      samples: cohort.samples,
    });
  }

  return { itemsWritten };
}
