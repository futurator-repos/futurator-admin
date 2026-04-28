'use client';

/**
 * Story 1.8.4 — Plan dashboard "Timing" panel.
 *
 * Renders:
 *   • Stacked horizontal bar — one segment per nonzero category, color-coded.
 *   • Total elapsed (mm:ss < 1h, hh:mm:ss otherwise).
 *   • Legend below the bar with per-category percentages + absolute times.
 *   • Live polling indicator when isLive === true.
 *   • Expandable per-story breakdown (grouped client-side from slices[].jobId).
 *   • "Export forensic JSON" download button.
 *
 * Download: uses an authenticated fetch → blob → object-URL pattern so the
 * Authorization header is passed with the request. The api-client handles
 * token refresh automatically.
 *
 * Phase-2 enhancement (If-Modified-Since):
 *   The hook tracks lastSliceCount client-side to skip re-renders when the
 *   slice array hasn't grown. When the API adds ETag / Last-Modified support
 *   in Phase 2, pass an `If-Modified-Since: <latest-slice-startedAt>` header
 *   via a custom fetch option so the server can return 304 Not Modified.
 */

import { useState, useMemo, useCallback } from 'react';
import { ChevronDown, ChevronRight, Download, Loader2 } from 'lucide-react';
import { usePlanTiming } from '@/hooks/use-plan-timing';
import type { TimerSlice, TimerCategory } from '../../../../functions/shared/timer/types';
import { TIMER_COLORS, TIMER_CATEGORY_LABELS, TIMER_CATEGORY_ORDER } from '@/lib/timer-colors';
import { formatDuration, formatMs } from '@/lib/format-duration';
import { api } from '@/lib/api-client';

// ── Stacked bar ────────────────────────────────────────────────────────────

interface CategoryShare {
  category: TimerCategory;
  totalMs: number;
  pct: number;
}

function buildShares(
  byCategory: Partial<Record<TimerCategory, { totalMs: number; count: number }>>,
  planTotalMs: number,
): CategoryShare[] {
  const total = planTotalMs > 0 ? planTotalMs : 1;
  return TIMER_CATEGORY_ORDER.flatMap((cat) => {
    const entry = byCategory[cat];
    if (!entry || entry.totalMs <= 0) return [];
    return [{ category: cat, totalMs: entry.totalMs, pct: (entry.totalMs / total) * 100 }];
  });
}

function StackedBar({
  shares,
  ariaLabel,
  height = 20,
}: {
  shares: CategoryShare[];
  ariaLabel: string;
  height?: number;
}) {
  if (shares.length === 0) {
    return (
      <div
        role="img"
        aria-label="No timing data yet"
        style={{
          height,
          background: 'var(--muted)',
          borderRadius: 4,
          width: '100%',
        }}
      />
    );
  }

  return (
    <div
      role="img"
      aria-label={ariaLabel}
      style={{
        display: 'flex',
        height,
        borderRadius: 4,
        overflow: 'hidden',
        width: '100%',
      }}
    >
      {shares.map(({ category, pct }) => (
        <div
          key={category}
          aria-label={`${TIMER_CATEGORY_LABELS[category]}: ${pct.toFixed(1)}%`}
          title={`${TIMER_CATEGORY_LABELS[category]}: ${pct.toFixed(1)}%`}
          style={{
            width: `${pct}%`,
            background: TIMER_COLORS[category],
            minWidth: pct > 0.5 ? 2 : 0,
          }}
        />
      ))}
    </div>
  );
}

// ── Legend ─────────────────────────────────────────────────────────────────

function Legend({ shares }: { shares: CategoryShare[] }) {
  if (shares.length === 0) return null;
  return (
    <div
      style={{
        display: 'flex',
        flexWrap: 'wrap',
        gap: '6px 14px',
        marginTop: 8,
      }}
    >
      {shares.map(({ category, totalMs, pct }) => (
        <div
          key={category}
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 5,
            fontSize: 11,
            color: 'var(--text-dim, #888)',
          }}
        >
          <span
            aria-hidden
            style={{
              display: 'inline-block',
              width: 10,
              height: 10,
              borderRadius: 2,
              background: TIMER_COLORS[category],
              flexShrink: 0,
            }}
          />
          <span>
            {TIMER_CATEGORY_LABELS[category]}{' '}
            <span style={{ color: 'var(--foreground)', fontVariantNumeric: 'tabular-nums' }}>
              {pct.toFixed(1)}%
            </span>{' '}
            <span style={{ opacity: 0.7 }}>({formatMs(totalMs)})</span>
          </span>
        </div>
      ))}
    </div>
  );
}

// ── Per-story expansion ─────────────────────────────────────────────────────

/** Group slices by jobId and compute per-job category totals. */
function groupByJob(
  slices: TimerSlice[],
): {
  jobId: string;
  totalMs: number;
  byCategory: Partial<Record<TimerCategory, { totalMs: number; count: number }>>;
}[] {
  const map = new Map<
    string,
    {
      totalMs: number;
      byCategory: Partial<Record<TimerCategory, { totalMs: number; count: number }>>;
    }
  >();
  for (const slice of slices) {
    const existing = map.get(slice.jobId) ?? { totalMs: 0, byCategory: {} };
    existing.totalMs += slice.durationMs;
    const catEntry = existing.byCategory[slice.category] ?? { totalMs: 0, count: 0 };
    catEntry.totalMs += slice.durationMs;
    catEntry.count += 1;
    existing.byCategory[slice.category] = catEntry;
    map.set(slice.jobId, existing);
  }
  return Array.from(map.entries())
    .map(([jobId, data]) => ({ jobId, ...data }))
    .sort((a, b) => b.totalMs - a.totalMs);
}

function JobBreakdownRow({
  jobId,
  totalMs,
  byCategory,
  planTotalMs,
}: {
  jobId: string;
  totalMs: number;
  byCategory: Partial<Record<TimerCategory, { totalMs: number; count: number }>>;
  planTotalMs: number;
}) {
  const shares = buildShares(byCategory, totalMs);
  const ariaLabel = `Job ${jobId}: ${shares.map((s) => `${TIMER_CATEGORY_LABELS[s.category]} ${s.pct.toFixed(0)}%`).join(', ')}`;
  return (
    <div style={{ marginTop: 8 }}>
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          fontSize: 11,
          color: 'var(--text-dim, #888)',
          marginBottom: 3,
        }}
      >
        <span
          style={{
            fontFamily: 'var(--font-mono)',
            maxWidth: '60%',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
        >
          {jobId}
        </span>
        <span style={{ fontVariantNumeric: 'tabular-nums' }}>
          {formatMs(totalMs)}{' '}
          <span style={{ opacity: 0.6 }}>
            ({planTotalMs > 0 ? ((totalMs / planTotalMs) * 100).toFixed(0) : '?'}%)
          </span>
        </span>
      </div>
      <StackedBar shares={shares} ariaLabel={ariaLabel} height={12} />
    </div>
  );
}

// ── Forensic download ──────────────────────────────────────────────────────

function useForensicDownload(planId: string) {
  const [downloading, setDownloading] = useState(false);
  const [downloadError, setDownloadError] = useState<string | null>(null);

  const download = useCallback(async () => {
    setDownloading(true);
    setDownloadError(null);
    try {
      // Use the api-client so the Authorization header is included and token
      // refresh is handled automatically. We fetch as a blob then generate an
      // object URL for programmatic click.
      const blob = await api.fetch<Blob>(`/plans/${planId}/timing/forensic`, {
        headers: { Accept: 'application/json' },
      });
      // api.fetch returns parsed JSON by default — re-stringify for download.
      const text = typeof blob === 'string' ? blob : JSON.stringify(blob, null, 2);
      const objectUrl = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
      const anchor = document.createElement('a');
      anchor.href = objectUrl;
      anchor.download = `${planId}-forensic.json`;
      document.body.appendChild(anchor);
      anchor.click();
      document.body.removeChild(anchor);
      URL.revokeObjectURL(objectUrl);
    } catch (err) {
      setDownloadError((err as Error).message ?? 'Download failed');
    } finally {
      setDownloading(false);
    }
  }, [planId]);

  return { download, downloading, downloadError };
}

// ── Main component ─────────────────────────────────────────────────────────

export function TimingPanel({ planId }: { planId: string }) {
  const { data, isLoading, error } = usePlanTiming(planId);
  const [expanded, setExpanded] = useState(false);
  const { download, downloading, downloadError } = useForensicDownload(planId);

  const shares = useMemo(() => {
    if (!data) return [];
    return buildShares(data.aggregate.byCategory, data.planTotalMs);
  }, [data]);

  const ariaLabel = useMemo(() => {
    if (shares.length === 0) return 'Timing breakdown: no data';
    return `Timing breakdown: ${shares.map((s) => `${TIMER_CATEGORY_LABELS[s.category]} ${s.pct.toFixed(0)}%`).join(', ')}`;
  }, [shares]);

  const jobGroups = useMemo(() => {
    if (!data) return [];
    return groupByJob(data.slices);
  }, [data]);

  if (isLoading) {
    return (
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          padding: '12px 0',
          fontSize: 12,
          color: 'var(--text-dim, #888)',
        }}
      >
        <Loader2 size={13} className="animate-spin" />
        Loading timing data…
      </div>
    );
  }

  if (error) {
    return (
      <div
        style={{
          padding: '10px 12px',
          fontSize: 12,
          color: 'var(--destructive, #dc2626)',
          background: 'color-mix(in srgb, var(--destructive, #dc2626) 8%, transparent)',
          borderRadius: 6,
          border: '1px solid color-mix(in srgb, var(--destructive, #dc2626) 25%, transparent)',
        }}
      >
        Failed to load timing: {(error as Error).message}
      </div>
    );
  }

  if (!data) return null;

  return (
    <div
      style={{
        border: '1px solid var(--border)',
        borderRadius: 8,
        padding: '14px 16px',
        background: 'var(--card, var(--bg-elev))',
      }}
    >
      {/* Header row */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          marginBottom: 10,
          gap: 8,
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--foreground)' }}>Timing</span>
          <span
            style={{
              fontFamily: 'var(--font-mono)',
              fontSize: 14,
              fontVariantNumeric: 'tabular-nums',
              color: 'var(--foreground)',
            }}
          >
            {formatDuration(data.planTotalMs)}
          </span>
          {data.isLive && (
            <span
              data-testid="live-indicator"
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 4,
                fontSize: 10,
                fontWeight: 600,
                letterSpacing: '0.06em',
                textTransform: 'uppercase',
                color: '#009E73',
                background: 'color-mix(in srgb, #009E73 12%, transparent)',
                border: '1px solid color-mix(in srgb, #009E73 30%, transparent)',
                borderRadius: 4,
                padding: '1px 6px',
              }}
            >
              <span
                aria-hidden
                style={{
                  display: 'inline-block',
                  width: 6,
                  height: 6,
                  borderRadius: '50%',
                  background: '#009E73',
                  animation: 'pulse 1.5s ease-in-out infinite',
                }}
              />
              Live
            </span>
          )}
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          {/* Export button */}
          <button
            type="button"
            onClick={download}
            disabled={downloading}
            data-testid="forensic-export-button"
            aria-label={`Export forensic JSON for plan ${planId}`}
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 5,
              fontSize: 11,
              padding: '3px 9px',
              borderRadius: 5,
              border: '1px solid var(--border)',
              background: 'transparent',
              color: 'var(--text-dim, #888)',
              cursor: downloading ? 'default' : 'pointer',
              opacity: downloading ? 0.6 : 1,
            }}
          >
            {downloading ? <Loader2 size={11} className="animate-spin" /> : <Download size={11} />}
            Export forensic JSON
          </button>
          {/* Expand / collapse per-story */}
          <button
            type="button"
            onClick={() => setExpanded((v) => !v)}
            aria-expanded={expanded}
            aria-label={expanded ? 'Collapse per-story breakdown' : 'Expand per-story breakdown'}
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 3,
              fontSize: 11,
              padding: '3px 6px',
              borderRadius: 5,
              border: 'none',
              background: 'transparent',
              color: 'var(--text-dim, #888)',
              cursor: 'pointer',
            }}
          >
            {expanded ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
            {expanded ? 'Collapse' : 'Per-story'}
          </button>
        </div>
      </div>

      {downloadError && (
        <p style={{ fontSize: 11, color: 'var(--destructive, #dc2626)', marginBottom: 6 }}>
          {downloadError}
        </p>
      )}

      {/* Main stacked bar */}
      <StackedBar shares={shares} ariaLabel={ariaLabel} />

      {/* Legend */}
      <Legend shares={shares} />

      {/* Per-story breakdown */}
      {expanded && jobGroups.length > 0 && (
        <div
          style={{
            marginTop: 14,
            borderTop: '1px solid var(--border)',
            paddingTop: 12,
          }}
        >
          <div
            style={{
              fontSize: 11,
              fontWeight: 600,
              color: 'var(--text-dim, #888)',
              marginBottom: 6,
            }}
          >
            Per-job breakdown ({jobGroups.length} jobs)
          </div>
          {jobGroups.map((group) => (
            <JobBreakdownRow
              key={group.jobId}
              jobId={group.jobId}
              totalMs={group.totalMs}
              byCategory={group.byCategory}
              planTotalMs={data.planTotalMs}
            />
          ))}
        </div>
      )}
    </div>
  );
}
