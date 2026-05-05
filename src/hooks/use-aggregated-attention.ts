'use client';
import { useMemo } from 'react';
import { useQueries } from '@tanstack/react-query';
import { api } from '@/lib/api-client';
import { dedupeAttentionItems, type DedupedAttentionItem } from './use-attention-items';
import type { AttentionItem } from '../../functions/shared/types/attention';

/**
 * Aggregated attention inbox — used by the Agentic Office attention tray.
 *
 * `useAttentionItems` works one plan at a time; the office shows a portfolio
 * view across multiple plans, so we fan out a parallel query per planId,
 * dedupe each plan's items, then merge into a single list with severity
 * + createdAt sorting. Returns zero counts while `planIds` is empty.
 */
export interface AggregatedAttentionResult {
  /** All unresolved items across the provided plans, ordered severity desc. */
  items: (DedupedAttentionItem & { planId: string })[];
  /** Count of unresolved items across the provided plans. */
  unresolvedCount: number;
  /** Total (including resolved) across the provided plans. */
  total: number;
  /** Highest severity present in the unresolved set. */
  topSeverity: 'critical' | 'high' | 'medium' | 'low' | null;
  /** Whether at least one underlying query is still loading. */
  isLoading: boolean;
}

const SEVERITY_RANK = { critical: 4, high: 3, medium: 2, low: 1 } as const;

export function useAggregatedAttention(planIds: readonly string[]): AggregatedAttentionResult {
  const queries = useQueries({
    queries: planIds.map((planId) => ({
      queryKey: ['attention-items', planId, 'all'],
      queryFn: async () => {
        const raw = await api.get<{ items: AttentionItem[]; total: number }>(
          `/plans/${planId}/attention-items`,
        );
        const items = dedupeAttentionItems(raw.items).map((it) => ({ ...it, planId }));
        return { items, total: raw.total };
      },
      enabled: !!planId,
      refetchInterval: 10_000,
      staleTime: 5_000,
    })),
  });

  return useMemo<AggregatedAttentionResult>(() => {
    if (!planIds.length) {
      return {
        items: [],
        unresolvedCount: 0,
        total: 0,
        topSeverity: null,
        isLoading: false,
      };
    }
    const isLoading = queries.some((q) => q.isLoading);
    const merged: (DedupedAttentionItem & { planId: string })[] = [];
    let total = 0;
    for (const q of queries) {
      if (!q.data) continue;
      total += q.data.total;
      for (const it of q.data.items) merged.push(it);
    }
    const unresolved = merged.filter((it) => it.status !== 'resolved');
    unresolved.sort((a, b) => {
      const rankDiff = SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity];
      if (rankDiff !== 0) return rankDiff;
      return b.createdAt.localeCompare(a.createdAt);
    });
    let topSeverity: AggregatedAttentionResult['topSeverity'] = null;
    if (unresolved.length > 0) topSeverity = unresolved[0].severity;
    return {
      items: unresolved,
      unresolvedCount: unresolved.length,
      total,
      topSeverity,
      isLoading,
    };
  }, [planIds, queries]);
}
