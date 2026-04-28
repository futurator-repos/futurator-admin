'use client';

/**
 * Story 1.8.5 — App detail Performance tab.
 *
 * Lists every delivered plan with:
 *   • Timestamp + duration
 *   • Mini stacked bar (per-category breakdown)
 *   • Cohort comparator chip per plan
 *   • Statistical drift markers (yellow ▲) when a category's median in the
 *     most-recent 5 plans has shifted ≥ 1 standard deviation from the prior 5.
 *   • Sortable by date / duration / each category column.
 *   • Empty state when 0 delivered plans.
 *
 * Cohort fetching:
 *   Each plan may have its own (templateType, planKind, epicCount) tuple.
 *   We call useCohort per unique tuple — TanStack Query dedupes at the key
 *   level so we never fire duplicate requests for the same params.
 *   staleTime for cohort queries is 30 min (see use-cohort.ts).
 *
 * Drift detection (client-side):
 *   Split recentPlans into "recent 5" and "prior 5" windows.
 *   For each TimerCategory, compute median(recent5[cat]) and SD(all10[cat]).
 *   If |median(recent5) - median(prior5)| ≥ 1 SD → flag the category.
 *   Tooltip: "review median shifted from 2m 14s to 5m 03s in the last 5 plans".
 */

import { useState, useMemo } from 'react';
import { ChevronUp, ChevronDown as ChevronDownIcon } from 'lucide-react';
import { useAppTiming } from '@/hooks/use-app-timing';
import { useCohort, COHORT_ACCUMULATING } from '@/hooks/use-cohort';
import type { PlanTimingSummary } from '@/hooks/use-app-timing';
import type { TimerCategory } from '../../../../functions/shared/timer/types';
import type { BoilerplateType, PlanKind } from '@/hooks/use-cohort';
import { TIMER_COLORS, TIMER_CATEGORY_LABELS, TIMER_CATEGORY_ORDER } from '@/lib/timer-colors';
import { formatMs } from '@/lib/format-duration';

// ── Math helpers ───────────────────────────────────────────────────────────

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

function stddev(values: number[]): number {
  if (values.length < 2) return 0;
  const m = values.reduce((a, b) => a + b, 0) / values.length;
  const variance = values.reduce((acc, v) => acc + (v - m) ** 2, 0) / values.length;
  return Math.sqrt(variance);
}

// ── Drift detection ────────────────────────────────────────────────────────

interface DriftResult {
  category: TimerCategory;
  recentMedianMs: number;
  priorMedianMs: number;
  tooltip: string;
}

function detectDrift(plans: PlanTimingSummary[]): DriftResult[] {
  if (plans.length < 6) return []; // Need at least 6 plans to compare windows

  // Sort newest first
  const sorted = [...plans].sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  const recent5 = sorted.slice(0, 5);
  const prior5 = sorted.slice(5, 10);
  if (prior5.length < 5) return [];

  const results: DriftResult[] = [];

  for (const cat of TIMER_CATEGORY_ORDER) {
    const recentVals = recent5.map((p) => p.byCategory[cat] ?? 0);
    const priorVals = prior5.map((p) => p.byCategory[cat] ?? 0);
    const allVals = [...recentVals, ...priorVals].filter((v) => v > 0);
    if (allVals.length < 2) continue;

    const sd = stddev(allVals);
    if (sd <= 0) continue;

    const recentMed = median(recentVals);
    const priorMed = median(priorVals);

    if (Math.abs(recentMed - priorMed) >= sd) {
      results.push({
        category: cat,
        recentMedianMs: recentMed,
        priorMedianMs: priorMed,
        tooltip: `${TIMER_CATEGORY_LABELS[cat]} median shifted from ${formatMs(priorMed)} to ${formatMs(recentMed)} in the last 5 plans`,
      });
    }
  }

  return results;
}

// ── Mini stacked bar ───────────────────────────────────────────────────────

function MiniBar({
  byCategory,
  durationMs,
}: {
  byCategory: Partial<Record<TimerCategory, number>>;
  durationMs: number;
}) {
  const total = durationMs > 0 ? durationMs : 1;
  const segments = TIMER_CATEGORY_ORDER.flatMap((cat) => {
    const ms = byCategory[cat];
    if (!ms || ms <= 0) return [];
    return [{ category: cat, pct: (ms / total) * 100 }];
  });

  if (segments.length === 0) {
    return (
      <div
        style={{ height: 10, background: 'var(--muted)', borderRadius: 2, width: 80 }}
        aria-label="No category data"
      />
    );
  }

  return (
    <div
      role="img"
      aria-label={segments
        .map((s) => `${TIMER_CATEGORY_LABELS[s.category]} ${s.pct.toFixed(0)}%`)
        .join(', ')}
      style={{ display: 'flex', height: 10, borderRadius: 2, overflow: 'hidden', width: 80 }}
    >
      {segments.map(({ category, pct }) => (
        <div
          key={category}
          title={`${TIMER_CATEGORY_LABELS[category]}: ${pct.toFixed(1)}%`}
          style={{
            width: `${pct}%`,
            background: TIMER_COLORS[category],
            minWidth: pct > 1 ? 1 : 0,
          }}
        />
      ))}
    </div>
  );
}

// ── Cohort chip ────────────────────────────────────────────────────────────

function CohortChip({
  templateType,
  planKind,
  epicCount,
  durationMs,
}: {
  templateType: BoilerplateType;
  planKind: PlanKind;
  epicCount: number;
  durationMs: number;
}) {
  const { data } = useCohort({ templateType, planKind, epicCount });

  if (!data) {
    return <span style={{ fontSize: 10, color: 'var(--text-dim, #888)' }}>…</span>;
  }

  if (data === COHORT_ACCUMULATING) {
    return (
      <span
        data-testid="cohort-accumulating"
        style={{
          fontSize: 10,
          color: 'var(--text-dim, #888)',
          background: 'var(--muted)',
          padding: '1px 5px',
          borderRadius: 3,
          border: '1px solid var(--border)',
        }}
      >
        Cohort accumulating
      </span>
    );
  }

  const ratio = data.medianMs > 0 ? durationMs / data.medianMs : null;
  const ratioStr = ratio !== null ? ratio.toFixed(1) : '—';
  const isHigh = ratio !== null && ratio > 1.5;
  const isLow = ratio !== null && ratio < 0.85;

  return (
    <span
      style={{
        fontSize: 10,
        color: isHigh ? 'var(--destructive, #dc2626)' : isLow ? '#009E73' : 'var(--text-dim, #888)',
        background: isHigh
          ? 'color-mix(in srgb, var(--destructive, #dc2626) 10%, transparent)'
          : 'var(--muted)',
        padding: '1px 5px',
        borderRadius: 3,
        border: `1px solid ${isHigh ? 'color-mix(in srgb, var(--destructive, #dc2626) 25%, transparent)' : 'var(--border)'}`,
        fontVariantNumeric: 'tabular-nums',
      }}
    >
      {ratioStr}× cohort
    </span>
  );
}

// ── Drift marker ────────────────────────────────────────────────────────────

function DriftMarker({ drift }: { drift: DriftResult }) {
  return (
    <span
      title={drift.tooltip}
      aria-label={drift.tooltip}
      style={{
        cursor: 'help',
        color: '#D97706', // amber
        fontSize: 11,
        marginLeft: 2,
      }}
    >
      ▲
    </span>
  );
}

// ── Sort controls ──────────────────────────────────────────────────────────

type SortField = 'date' | 'duration';
type SortDir = 'asc' | 'desc';

function SortButton({
  label,
  active,
  dir,
  onToggle,
}: {
  label: string;
  active: boolean;
  dir: SortDir;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-label={`Sort by ${label}${active ? ` (${dir === 'asc' ? 'ascending' : 'descending'})` : ''}`}
      style={{
        fontSize: 11,
        fontWeight: active ? 600 : 400,
        color: active ? 'var(--foreground)' : 'var(--text-dim, #888)',
        background: 'transparent',
        border: 'none',
        cursor: 'pointer',
        display: 'inline-flex',
        alignItems: 'center',
        gap: 2,
        padding: '2px 4px',
        borderRadius: 3,
      }}
    >
      {label}
      {active && (dir === 'asc' ? <ChevronUp size={10} /> : <ChevronDownIcon size={10} />)}
    </button>
  );
}

// ── Plan row ───────────────────────────────────────────────────────────────

function PlanRow({
  plan,
  driftedCategories,
  isNewest,
  templateType,
}: {
  plan: PlanTimingSummary;
  driftedCategories: Set<TimerCategory>;
  isNewest: boolean;
  templateType: BoilerplateType;
}) {
  const planKind: PlanKind =
    ((plan as unknown as Record<string, unknown>).planKind as PlanKind | undefined) ?? 'initial';
  const epicCount: number =
    ((plan as unknown as Record<string, unknown>).epicCount as number | undefined) ?? 3;

  const date = new Date(plan.startedAt);
  const dateStr = date.toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    year: '2-digit',
  });
  const timeStr = date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });

  return (
    <tr
      style={{
        borderBottom: '1px solid var(--border)',
        fontSize: 12,
        color: 'var(--foreground)',
      }}
    >
      <td style={{ padding: '6px 8px', whiteSpace: 'nowrap', color: 'var(--text-dim, #888)' }}>
        <span>{dateStr}</span> <span style={{ opacity: 0.6, fontSize: 10 }}>{timeStr}</span>
      </td>
      <td style={{ padding: '6px 8px', fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' }}>
        {formatMs(plan.durationMs)}
        {/* Drift markers on the most recent plan's duration cell */}
        {isNewest &&
          Array.from(driftedCategories).map((cat) => (
            <DriftMarker
              key={cat}
              drift={{
                category: cat,
                recentMedianMs: 0,
                priorMedianMs: 0,
                tooltip: '',
              }}
            />
          ))}
      </td>
      <td style={{ padding: '6px 8px' }}>
        <MiniBar byCategory={plan.byCategory} durationMs={plan.durationMs} />
      </td>
      <td style={{ padding: '6px 8px' }}>
        <CohortChip
          templateType={templateType}
          planKind={planKind}
          epicCount={epicCount}
          durationMs={plan.durationMs}
        />
      </td>
      <td
        style={{
          padding: '6px 8px',
          fontFamily: 'var(--font-mono)',
          fontSize: 10,
          color: 'var(--text-dim, #888)',
          maxWidth: 120,
        }}
      >
        <span
          style={{
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            display: 'block',
            whiteSpace: 'nowrap',
          }}
          title={plan.planId}
        >
          {plan.planId.slice(0, 8)}…
        </span>
      </td>
    </tr>
  );
}

// ── Main component ─────────────────────────────────────────────────────────

export function PerformanceTab({
  appId,
  app,
}: {
  appId: string;
  app: { boilerplateType?: string };
}) {
  const { data, isLoading } = useAppTiming(appId);
  const [sortField, setSortField] = useState<SortField>('date');
  const [sortDir, setSortDir] = useState<SortDir>('desc');

  const templateType: BoilerplateType =
    (app.boilerplateType as BoilerplateType | undefined) ?? 'nextjs';

  function toggleSort(field: SortField) {
    setSortField((prev) => {
      if (prev === field) {
        setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
        return prev;
      }
      setSortDir('desc');
      return field;
    });
  }

  // Stable memo to avoid "logical expression changes deps every render" lint warning
  const plans = useMemo(() => data?.recentPlans ?? [], [data]);

  const driftResults = useMemo(() => detectDrift(plans), [plans]);
  const driftedCategories = useMemo(
    () => new Set<TimerCategory>(driftResults.map((d) => d.category)),
    [driftResults],
  );

  const sorted = useMemo(() => {
    const copy = [...plans];
    copy.sort((a, b) => {
      let cmp = 0;
      if (sortField === 'date') {
        cmp = a.startedAt.localeCompare(b.startedAt);
      } else if (sortField === 'duration') {
        cmp = a.durationMs - b.durationMs;
      }
      return sortDir === 'asc' ? cmp : -cmp;
    });
    return copy;
  }, [plans, sortField, sortDir]);

  // ID of the actual newest plan (for drift marker placement)
  const newestPlanId = useMemo(
    () =>
      plans.length > 0
        ? [...plans].sort((a, b) => b.startedAt.localeCompare(a.startedAt))[0].planId
        : null,
    [plans],
  );

  if (isLoading) {
    return (
      <div style={{ padding: '24px 0', fontSize: 12, color: 'var(--text-dim, #888)' }}>
        Loading performance data…
      </div>
    );
  }

  if (plans.length === 0) {
    return (
      <div
        data-testid="performance-empty-state"
        style={{
          padding: '32px 0',
          textAlign: 'center',
          fontSize: 13,
          color: 'var(--text-dim, #888)',
        }}
      >
        Run a plan to see performance data.
      </div>
    );
  }

  return (
    <div>
      {/* Drift summary banner */}
      {driftResults.length > 0 && (
        <div
          style={{
            marginBottom: 12,
            padding: '8px 12px',
            background: 'color-mix(in srgb, #D97706 10%, transparent)',
            border: '1px solid color-mix(in srgb, #D97706 30%, transparent)',
            borderRadius: 6,
            fontSize: 11,
            color: 'var(--foreground)',
          }}
        >
          <strong style={{ color: '#D97706' }}>⚠ Statistical drift detected</strong> in the last 5
          plans:{' '}
          {driftResults.map((d, i) => (
            <span key={d.category}>
              {i > 0 && ', '}
              <span title={d.tooltip}>{TIMER_CATEGORY_LABELS[d.category]}</span>
            </span>
          ))}
          . Hover ▲ for details.
        </div>
      )}

      <div style={{ overflowX: 'auto' }}>
        <table
          style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}
          aria-label="Plan performance history"
        >
          <thead>
            <tr style={{ borderBottom: '1px solid var(--border)' }}>
              <th
                style={{
                  padding: '4px 8px',
                  textAlign: 'left',
                  fontWeight: 500,
                  fontSize: 11,
                  color: 'var(--text-dim, #888)',
                }}
              >
                <SortButton
                  label="Date"
                  active={sortField === 'date'}
                  dir={sortDir}
                  onToggle={() => toggleSort('date')}
                />
              </th>
              <th
                style={{
                  padding: '4px 8px',
                  textAlign: 'left',
                  fontWeight: 500,
                  fontSize: 11,
                  color: 'var(--text-dim, #888)',
                }}
              >
                <SortButton
                  label="Duration"
                  active={sortField === 'duration'}
                  dir={sortDir}
                  onToggle={() => toggleSort('duration')}
                />
              </th>
              <th
                style={{
                  padding: '4px 8px',
                  textAlign: 'left',
                  fontWeight: 500,
                  fontSize: 11,
                  color: 'var(--text-dim, #888)',
                }}
              >
                Breakdown
              </th>
              <th
                style={{
                  padding: '4px 8px',
                  textAlign: 'left',
                  fontWeight: 500,
                  fontSize: 11,
                  color: 'var(--text-dim, #888)',
                }}
              >
                Cohort
              </th>
              <th
                style={{
                  padding: '4px 8px',
                  textAlign: 'left',
                  fontWeight: 500,
                  fontSize: 11,
                  color: 'var(--text-dim, #888)',
                }}
              >
                Plan ID
              </th>
            </tr>
          </thead>
          <tbody>
            {sorted.map((plan) => (
              <PlanRow
                key={plan.planId}
                plan={plan}
                driftedCategories={driftedCategories}
                isNewest={plan.planId === newestPlanId}
                templateType={templateType}
              />
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
