'use client';
import { useMemo } from 'react';
import { useOfficeStore } from '../store';
import {
  useAggregatedAttention,
  type AggregatedAttentionResult,
} from '@/hooks/use-aggregated-attention';
import { paletteForPlanId } from '../plan-palette';
import type { AttentionSeverity } from '../../../../functions/shared/types/attention';

const SEVERITY_ORDER: AttentionSeverity[] = ['critical', 'high', 'medium', 'low'];

const SEVERITY_LABEL: Record<AttentionSeverity, string> = {
  critical: 'Critical',
  high: 'High',
  medium: 'Medium',
  low: 'Low',
};

const SEVERITY_CLASS: Record<AttentionSeverity, string> = {
  critical: 'bg-red-500/20 text-red-200 border-red-400/50',
  high: 'bg-amber-500/20 text-amber-200 border-amber-400/50',
  medium: 'bg-yellow-500/15 text-yellow-200 border-yellow-400/40',
  low: 'bg-blue-500/15 text-blue-200 border-blue-400/40',
};

/**
 * In-office attention panel — cross-plan aggregated view.
 *
 * Opens when the attention tray mesh is clicked. Lists unresolved items
 * across the plans currently in the kanban filter (or the whole portfolio
 * if the filter is empty). Each row shows the owning plan's palette
 * swatch so users can correlate with the in-scene desk tags.
 */
export function AttentionPanel({
  planIdsForQuery,
  result,
  planNameById,
}: {
  /** Which plans were queried — used for dual-display ("filtered only"). */
  planIdsForQuery: readonly string[];
  /** The already-fetched aggregated hook result (shared with the tray). */
  result: AggregatedAttentionResult;
  planNameById: Map<string, string>;
}) {
  const open = useOfficeStore((s) => s.attentionOpen);
  const setOpen = useOfficeStore((s) => s.setAttentionOpen);

  const bySeverity = useMemo(() => {
    const groups: Record<AttentionSeverity, typeof result.items> = {
      critical: [],
      high: [],
      medium: [],
      low: [],
    };
    for (const item of result.items) {
      groups[item.severity].push(item);
    }
    return groups;
  }, [result.items]);

  if (!open) return null;

  return (
    <div className="pointer-events-auto absolute right-3 top-14 bottom-3 w-[380px] overflow-hidden rounded-lg border border-border/60 bg-black/85 backdrop-blur-md">
      <div className="flex items-center justify-between border-b border-border/60 px-4 py-2.5">
        <div className="flex items-center gap-2">
          <span className="text-[13px] font-semibold text-white">Attention</span>
          <span className="text-[10px] text-white/50">
            {result.unresolvedCount} unresolved · {planIdsForQuery.length}{' '}
            {planIdsForQuery.length === 1 ? 'plan' : 'plans'}
          </span>
        </div>
        <button
          type="button"
          onClick={() => setOpen(false)}
          className="text-[11px] text-white/70 hover:text-white"
        >
          ✕
        </button>
      </div>

      <div className="max-h-[calc(100%-3rem)] overflow-y-auto p-3">
        {result.isLoading && result.items.length === 0 && (
          <div className="py-10 text-center text-[11px] italic text-white/40">
            Loading…
          </div>
        )}
        {!result.isLoading && result.items.length === 0 && (
          <div className="py-10 text-center text-[11px] italic text-white/40">
            No unresolved items. Office is calm.
          </div>
        )}

        {SEVERITY_ORDER.map((sev) => {
          const items = bySeverity[sev];
          if (!items || items.length === 0) return null;
          return (
            <section key={sev} className="mb-3">
              <div
                className={`mb-1.5 inline-block rounded border px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wider ${SEVERITY_CLASS[sev]}`}
              >
                {SEVERITY_LABEL[sev]} · {items.length}
              </div>
              <ul className="space-y-1.5">
                {items.map((item) => {
                  const palette = paletteForPlanId(item.planId);
                  const planName = planNameById.get(item.planId) ?? item.planId.slice(0, 8);
                  return (
                    <li
                      key={`${item.planId}:${item.itemId}`}
                      className="rounded-md border border-border/40 bg-white/5 p-2 text-[11px] text-white/90"
                    >
                      <div className="flex items-start gap-2">
                        <span
                          className="mt-0.5 inline-block h-2.5 w-2.5 shrink-0 rounded-full"
                          style={{ backgroundColor: palette.hex }}
                          title={`Plan: ${planName}`}
                        />
                        <div className="min-w-0 flex-1">
                          <div className="font-medium leading-snug">{item.title}</div>
                          {item.body && (
                            <div className="mt-0.5 line-clamp-2 text-[10px] text-white/60">
                              {item.body}
                            </div>
                          )}
                          <div className="mt-1 flex items-center gap-2 text-[9px] text-white/40">
                            <span className="truncate">{planName}</span>
                            <span>·</span>
                            <span>{item.category}</span>
                            {item.duplicateCount > 0 && (
                              <span className="ml-auto rounded bg-white/10 px-1">
                                +{item.duplicateCount}
                              </span>
                            )}
                          </div>
                        </div>
                      </div>
                    </li>
                  );
                })}
              </ul>
            </section>
          );
        })}
      </div>
    </div>
  );
}
