'use client';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api-client';
import type { AttentionItem, AttentionStatus } from '../../functions/shared/types/attention';

export interface AttentionListResponse {
  items: AttentionItem[];
  unresolvedCount: number;
  total: number;
}

/**
 * Attention items with optional client-side dedupe.
 *
 * Pipeline v2.0 PR-7 (G+H): rows written via the new upsert path carry a
 * `dedupKey` + `recurrenceCount` and are already collapsed server-side —
 * one row per logical failure, recurrenceCount tracks observation count.
 * For those rows, this function just maps `recurrenceCount → duplicateCount`
 * (subtracting 1 because the card shows "+N more" while recurrenceCount
 * counts the row itself).
 *
 * Legacy pre-PR-7 rows (no dedupKey) still go through the original
 * (title + storyId, 60s window) bucket logic — necessary until those rows
 * age out of the table.
 */
export interface DedupedAttentionItem extends AttentionItem {
  duplicateCount: number;
}

const DEDUPE_WINDOW_MS = 60_000;

export function dedupeAttentionItems(items: AttentionItem[]): DedupedAttentionItem[] {
  // Split server-deduped (PR-7+) from legacy rows.
  const serverDeduped: DedupedAttentionItem[] = [];
  const legacy: AttentionItem[] = [];
  for (const item of items) {
    if (item.dedupKey) {
      const recurrence = item.recurrenceCount ?? 1;
      serverDeduped.push({
        ...item,
        duplicateCount: Math.max(0, recurrence - 1),
      });
    } else {
      legacy.push(item);
    }
  }

  // Legacy bucketing — same algorithm as before for non-PR-7 rows.
  const sorted = [...legacy].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const buckets = new Map<string, DedupedAttentionItem>();
  for (const item of sorted) {
    const storyKey = item.context?.storyId || '-';
    const baseKey = `${item.title}::${storyKey}`;
    let bucket: DedupedAttentionItem | undefined;
    for (const [key, existing] of buckets) {
      if (!key.startsWith(baseKey)) continue;
      const delta = new Date(item.createdAt).getTime() - new Date(existing.createdAt).getTime();
      if (delta <= DEDUPE_WINDOW_MS) {
        bucket = existing;
        break;
      }
    }
    if (bucket) {
      bucket.duplicateCount += 1;
    } else {
      buckets.set(`${baseKey}::${item.createdAt}`, {
        ...item,
        duplicateCount: 0,
      });
    }
  }
  return [...serverDeduped, ...Array.from(buckets.values())];
}

export function useAttentionItems(planId: string | null, statusFilter?: AttentionStatus) {
  return useQuery({
    queryKey: ['attention-items', planId, statusFilter || 'all'],
    queryFn: async () => {
      const qs = statusFilter ? `?status=${statusFilter}` : '';
      const raw = await api.get<AttentionListResponse>(`/plans/${planId}/attention-items${qs}`);
      const items = dedupeAttentionItems(raw.items);
      const unresolvedCount = items.filter((it) => it.status !== 'resolved').length;
      return { items, unresolvedCount, total: raw.total };
    },
    enabled: !!planId,
    refetchInterval: 10_000,
  });
}

export function useResolveAttentionItem(planId: string | null) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (itemId: string) =>
      api.post<{ item: AttentionItem }>(`/plans/${planId}/attention-items/${itemId}/resolve`, {}),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['attention-items', planId] });
    },
  });
}

export function useReopenAttentionItem(planId: string | null) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (itemId: string) =>
      api.post<{ item: AttentionItem }>(`/plans/${planId}/attention-items/${itemId}/reopen`, {}),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['attention-items', planId] });
    },
  });
}
