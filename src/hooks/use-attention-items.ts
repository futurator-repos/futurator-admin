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
 * Attention items, with client-side dedupe applied.
 *
 * Phase B.5: daemon and wave-reducer both write items (Q4 "both", Q13
 * "daemon also writes"). When the same failure pops up from both sources
 * we get duplicate cards. Collapse items where (title + storyId) match and
 * createdAt falls inside a 60-second window; keep the earliest, surface a
 * `duplicateCount` so the card can show "+N".
 */
export interface DedupedAttentionItem extends AttentionItem {
  duplicateCount: number;
}

const DEDUPE_WINDOW_MS = 60_000;

export function dedupeAttentionItems(items: AttentionItem[]): DedupedAttentionItem[] {
  const sorted = [...items].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const buckets = new Map<string, DedupedAttentionItem>();
  for (const item of sorted) {
    const storyKey = item.context?.storyId || '-';
    const baseKey = `${item.title}::${storyKey}`;
    // Look for an existing bucket within the window; because `sorted` is
    // asc, the first match is the earliest.
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
      // Use createdAt in the key so non-overlapping bursts of the same
      // title+storyId get separate buckets.
      buckets.set(`${baseKey}::${item.createdAt}`, {
        ...item,
        duplicateCount: 0,
      });
    }
  }
  return Array.from(buckets.values());
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
