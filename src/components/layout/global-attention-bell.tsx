'use client';

/**
 * Pipeline v2.0 PR-7 (J) — Labs-root attention bell.
 *
 * Persistent in the admin header, visible on every page (not just per-plan).
 * Surfaces the cross-plan unresolved count so an operator on the Apps grid /
 * Settings / Resources page sees that something needs attention without
 * navigating into a specific plan.
 *
 * Click → drawer grouped by plan + severity. Each item deep-links to
 * /labs?planId=<>&storyId=<> so the operator lands on the failure surface
 * without manual navigation.
 *
 * Dedup: server-side via PR-7 (G). The /api/attention rollup returns one
 * row per (planId, dedupKey); the legacy duplicate-collapsing behavior in
 * `dedupeAttentionItems` is unnecessary here because the server response
 * is already collapsed.
 */

import { useState } from 'react';
import { Bell, X } from 'lucide-react';
import { useRouter } from 'next/navigation';
import {
  useGlobalAttention,
  useResolveGlobalAttention,
  useResolveAllForPlan,
} from '@/hooks/use-global-attention';
import type { AttentionSeverity, AttentionItem } from '../../../functions/shared/types/attention';
import type { GlobalAttentionItem } from '@/hooks/use-global-attention';

const SEVERITY_RANK: Record<AttentionSeverity, number> = {
  critical: 4,
  high: 3,
  medium: 2,
  low: 1,
};

const SEVERITY_BADGE_CLASS: Record<AttentionSeverity, string> = {
  critical: 'border-red-500 text-red-600 dark:text-red-400',
  high: 'border-amber-500 text-amber-600 dark:text-amber-400',
  medium: 'border-yellow-500 text-yellow-700 dark:text-yellow-300',
  low: 'border-blue-500 text-blue-600 dark:text-blue-400',
};

export function GlobalAttentionBell() {
  const [open, setOpen] = useState(false);
  const { data, isLoading } = useGlobalAttention({ status: 'open' });
  const unresolvedCount = data?.unresolvedCount ?? 0;

  return (
    <>
      <button
        type="button"
        aria-label={`${unresolvedCount} attention items`}
        onClick={() => setOpen((o) => !o)}
        className="relative flex h-8 w-8 items-center justify-center rounded text-muted-foreground hover:text-foreground hover:bg-muted/40 transition-colors"
      >
        <Bell className="size-4" aria-hidden />
        {unresolvedCount > 0 && (
          <span
            className="absolute -top-0.5 -right-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-amber-500/90 px-1 text-[9px] font-medium text-white tabular-nums"
            aria-hidden
          >
            {unresolvedCount > 99 ? '99+' : unresolvedCount}
          </span>
        )}
      </button>
      {open && (
        <GlobalAttentionDrawer
          onClose={() => setOpen(false)}
          items={data?.items ?? []}
          isLoading={isLoading}
        />
      )}
    </>
  );
}

function GlobalAttentionDrawer({
  onClose,
  items,
  isLoading,
}: {
  onClose: () => void;
  items: GlobalAttentionItem[];
  isLoading: boolean;
}) {
  const router = useRouter();
  const resolve = useResolveGlobalAttention();
  const resolveAll = useResolveAllForPlan();

  // Group by plan, sort plans alphabetically, sort items within plan by
  // severity desc then createdAt desc.
  const grouped = new Map<
    string,
    { planId: string; planName: string; items: GlobalAttentionItem[] }
  >();
  for (const item of items) {
    const key = item.planId;
    if (!grouped.has(key)) {
      grouped.set(key, {
        planId: item.planId,
        planName: item.planName ?? item.planId,
        items: [],
      });
    }
    grouped.get(key)!.items.push(item);
  }
  for (const group of grouped.values()) {
    group.items.sort((a, b) => {
      const sev = SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity];
      if (sev !== 0) return sev;
      return b.createdAt.localeCompare(a.createdAt);
    });
  }
  const groups = Array.from(grouped.values()).sort((a, b) => a.planName.localeCompare(b.planName));

  return (
    <>
      {/* Click-outside backdrop */}
      <div className="fixed inset-0 z-40" onClick={onClose} aria-hidden />
      {/* Drawer */}
      <aside
        role="dialog"
        aria-label="Attention inbox"
        className="fixed right-3 top-14 bottom-3 z-50 w-[420px] overflow-hidden rounded-lg border border-border bg-card shadow-lg flex flex-col"
      >
        <header className="flex items-center justify-between border-b border-border px-4 py-3">
          <div className="flex items-center gap-2">
            <Bell className="size-3.5 text-muted-foreground" aria-hidden />
            <span className="text-sm font-medium">Attention</span>
            <span className="text-xs text-muted-foreground">
              {items.length} unresolved across {groups.length}{' '}
              {groups.length === 1 ? 'plan' : 'plans'}
            </span>
          </div>
          <button
            type="button"
            aria-label="Close"
            onClick={onClose}
            className="text-muted-foreground hover:text-foreground"
          >
            <X className="size-4" aria-hidden />
          </button>
        </header>
        <div className="flex-1 overflow-y-auto">
          {isLoading && <div className="px-4 py-6 text-xs text-muted-foreground">Loading…</div>}
          {!isLoading && groups.length === 0 && (
            <div className="px-4 py-6 text-xs text-muted-foreground">
              No unresolved attention items. Nice.
            </div>
          )}
          {groups.map((group) => (
            <section key={group.planId} className="border-b border-border last:border-b-0">
              <header className="flex items-center justify-between px-4 py-2 bg-muted/40 sticky top-0 gap-2">
                <span className="text-[11px] font-mono uppercase tracking-wide text-muted-foreground truncate">
                  {group.planName}
                </span>
                <div className="flex items-center gap-2 flex-shrink-0">
                  <span className="text-[10px] text-muted-foreground tabular-nums">
                    {group.items.length}
                  </span>
                  {/* PR-9 #4 — bulk-resolve all open items for this plan. Useful for
                      pre-PR-7 noise (where each cron tick wrote a fresh row before
                      the idempotent upsert landed). */}
                  <button
                    type="button"
                    onClick={() => {
                      if (
                        confirm(
                          `Resolve all ${group.items.length} open attention items for "${group.planName}"?`,
                        )
                      ) {
                        resolveAll.mutate(group.planId);
                      }
                    }}
                    disabled={resolveAll.isPending}
                    className="text-[10px] font-mono uppercase tracking-wide text-muted-foreground border border-border rounded px-1.5 py-0.5 hover:text-foreground hover:bg-background disabled:opacity-50"
                    title="Resolve every open item for this plan"
                  >
                    Clear all
                  </button>
                </div>
              </header>
              <ul className="divide-y divide-border">
                {group.items.map((item) => (
                  <AttentionRow
                    key={item.itemId}
                    item={item}
                    onOpen={() => {
                      const params = new URLSearchParams({ planId: item.planId });
                      if (item.context?.storyId) {
                        params.set('storyId', item.context.storyId);
                      }
                      router.push(`/labs?${params.toString()}`);
                      onClose();
                    }}
                    onResolve={() => resolve.mutate({ planId: item.planId, itemId: item.itemId })}
                    isResolving={resolve.isPending}
                  />
                ))}
              </ul>
            </section>
          ))}
        </div>
      </aside>
    </>
  );
}

/**
 * PR-9 #5 — humanize a timestamp into "3h ago" / "2d ago" / etc. so the
 * operator can tell at-a-glance which incident an item belongs to without
 * cross-referencing logs. Falls back to ISO date for items >30d old.
 */
function relativeTime(iso: string): string {
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return iso;
  const diffSec = Math.max(0, Math.round((Date.now() - then) / 1000));
  if (diffSec < 60) return 'just now';
  const diffMin = Math.round(diffSec / 60);
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHour = Math.round(diffMin / 60);
  if (diffHour < 24) return `${diffHour}h ago`;
  const diffDay = Math.round(diffHour / 24);
  if (diffDay < 30) return `${diffDay}d ago`;
  return new Date(then).toISOString().slice(0, 10);
}

function AttentionRow({
  item,
  onOpen,
  onResolve,
  isResolving,
}: {
  item: AttentionItem;
  onOpen: () => void;
  onResolve: () => void;
  isResolving: boolean;
}) {
  const recurrence = item.recurrenceCount ?? 1;
  // PR-9 #5 — `lastSeenAt` is set by the PR-7 idempotent upsert; legacy items
  // (pre-PR-7, the 224 noise the user is seeing) don't have it, so fall back
  // to `createdAt`. ISO timestamp on hover for precise inspection.
  const seenAt = item.lastSeenAt ?? item.createdAt;
  return (
    <li className="px-4 py-3">
      <div className="flex items-baseline gap-2 flex-wrap">
        <span
          className={`inline-flex items-center rounded border px-1.5 py-0 text-[9px] font-mono uppercase tracking-wide ${SEVERITY_BADGE_CLASS[item.severity]}`}
        >
          {item.severity}
        </span>
        <span className="text-[10px] font-mono text-muted-foreground">{item.category}</span>
        {recurrence > 1 && (
          <span
            title={`Observed ${recurrence}× — recurrence count from server-side dedup`}
            className="text-[10px] font-mono text-muted-foreground border border-border rounded px-1"
          >
            {recurrence}×
          </span>
        )}
        <span
          title={seenAt}
          className="ml-auto text-[10px] font-mono text-muted-foreground tabular-nums"
        >
          {relativeTime(seenAt)}
        </span>
      </div>
      <h4 className="mt-1.5 text-sm leading-tight text-foreground">{item.title}</h4>
      {item.body && (
        <p className="mt-1 text-xs leading-snug text-muted-foreground line-clamp-2">{item.body}</p>
      )}
      <div className="mt-2 flex gap-2">
        <button
          type="button"
          onClick={onOpen}
          className="text-[11px] text-foreground border border-border rounded px-2 py-1 hover:bg-muted/40"
        >
          Open
        </button>
        <button
          type="button"
          onClick={onResolve}
          disabled={isResolving}
          className="text-[11px] text-muted-foreground border border-border rounded px-2 py-1 hover:bg-muted/40 disabled:opacity-50"
        >
          Resolve
        </button>
      </div>
    </li>
  );
}
