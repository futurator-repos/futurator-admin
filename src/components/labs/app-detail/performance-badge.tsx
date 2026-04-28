'use client';

/**
 * Story 1.8.5 — App detail performance badge.
 *
 * Shows median plan duration across the App's last 20 delivered plans, plus
 * a ratio vs cohort median (e.g. "1.4× cohort").
 *
 * Hidden when the App has fewer than 2 delivered plans.
 *
 * Cohort: uses the boilerplateType from the App row (falling back to 'nextjs'
 * for legacy apps where the field is absent) + the most common planKind in
 * recentPlans + a representative epicCount. One useCohort call is shared with
 * the Performance tab via TanStack Query key deduplication.
 */

import { useMemo } from 'react';
import { useAppTiming } from '@/hooks/use-app-timing';
import { useCohort, COHORT_ACCUMULATING } from '@/hooks/use-cohort';
import type { App } from '@/types/app';
import { formatMs } from '@/lib/format-duration';
import type { PlanKind, BoilerplateType } from '@/hooks/use-cohort';
import type { PlanTimingSummary } from '@/hooks/use-app-timing';

function medianOf(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

/** Pick the most common planKind from recentPlans, defaulting to 'initial'. */
function dominantKind(plans: PlanTimingSummary[]): PlanKind {
  if (plans.length === 0) return 'initial';
  const counts = new Map<string, number>();
  for (const p of plans) {
    const k =
      ((p as unknown as Record<string, unknown>).planKind as string | undefined) ?? 'initial';
    counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  let best = 'initial';
  let max = 0;
  for (const [k, n] of counts) {
    if (n > max) {
      max = n;
      best = k;
    }
  }
  return best as PlanKind;
}

export function PerformanceBadge({ app }: { app: App }) {
  const { data } = useAppTiming(app.appId);

  // Stable memo of recent plans (avoids "logical expression changes deps every render" lint)
  const recentPlans = useMemo(() => data?.recentPlans ?? [], [data]);

  const medianMs = useMemo(() => {
    if (recentPlans.length < 2) return null;
    return medianOf(recentPlans.map((p) => p.durationMs));
  }, [recentPlans]);

  const templateType: BoilerplateType =
    ((app as unknown as Record<string, unknown>).boilerplateType as BoilerplateType | undefined) ??
    'nextjs';

  const planKind = useMemo(() => dominantKind(recentPlans), [recentPlans]);

  const epicCount = useMemo(() => {
    if (recentPlans.length === 0) return 3;
    const counts = recentPlans.map(
      (p) => ((p as unknown as Record<string, unknown>).epicCount as number | undefined) ?? 3,
    );
    return Math.round(medianOf(counts));
  }, [recentPlans]);

  // Always call useCohort (hooks must not be called conditionally).
  // We pass the derived params; when medianMs is null we won't render anyway.
  const { data: cohortData } = useCohort({
    templateType,
    planKind,
    epicCount,
  });

  const cohortRatio = useMemo(() => {
    if (medianMs === null || !cohortData || cohortData === COHORT_ACCUMULATING) return null;
    if (cohortData.medianMs <= 0) return null;
    return (medianMs / cohortData.medianMs).toFixed(1);
  }, [medianMs, cohortData]);

  // Hidden when fewer than 2 delivered plans
  if (medianMs === null) return null;

  const ratioNum = cohortRatio !== null ? parseFloat(cohortRatio) : null;

  return (
    <div
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 6,
        padding: '2px 10px',
        borderRadius: 6,
        border: '1px solid var(--border)',
        background: 'var(--card, var(--bg-elev))',
        fontSize: 12,
        color: 'var(--foreground)',
      }}
      title={`Median plan duration across ${recentPlans.length} delivered plans`}
    >
      <span aria-label="Median plan duration" style={{ fontVariantNumeric: 'tabular-nums' }}>
        ⏱ {formatMs(medianMs)}
      </span>
      {cohortData === COHORT_ACCUMULATING && (
        <span
          style={{
            fontSize: 10,
            color: 'var(--text-dim, #888)',
            background: 'var(--muted)',
            padding: '1px 5px',
            borderRadius: 4,
          }}
        >
          Cohort accumulating
        </span>
      )}
      {cohortRatio !== null && ratioNum !== null && (
        <span
          style={{
            fontSize: 10,
            color:
              ratioNum > 1.5
                ? 'var(--destructive, #dc2626)'
                : ratioNum < 0.85
                  ? '#009E73'
                  : 'var(--text-dim, #888)',
            fontVariantNumeric: 'tabular-nums',
          }}
        >
          {cohortRatio}× cohort
        </span>
      )}
    </div>
  );
}
