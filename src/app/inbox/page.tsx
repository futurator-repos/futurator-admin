'use client';
/**
 * Pipeline v1 — Story 1.10. Cross-plan attention inbox.
 *
 * One screen showing every NEEDS_ATTENTION / FAILED item across all plans,
 * with severity + plan filters and inline action shortcuts. Polls every
 * 30s (handled by the underlying useGlobalAttention hook).
 */
import { useMemo, useState } from 'react';
import { AppShell } from '@/components/layout/app-shell';
import { AuthGuard } from '@/components/auth/auth-guard';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { useGlobalAttention, useResolveGlobalAttention } from '@/hooks/use-global-attention';
import type { AttentionSeverity } from '../../../functions/shared/types/attention';

const SEVERITY_RANK: Record<AttentionSeverity, number> = {
  critical: 4,
  high: 3,
  medium: 2,
  low: 1,
};

type SeverityChip = AttentionSeverity | 'all';

function InboxContent() {
  const [severity, setSeverity] = useState<SeverityChip>('all');
  const [planFilter, setPlanFilter] = useState<string>('all');
  const [showResolved, setShowResolved] = useState(false);

  const { data, isLoading } = useGlobalAttention({ status: showResolved ? 'all' : 'open' });
  const resolve = useResolveGlobalAttention();

  const planNames = useMemo(() => {
    const set = new Set<string>();
    for (const it of data?.items || []) {
      if (it.planName) set.add(it.planName);
    }
    return ['all', ...Array.from(set).sort()];
  }, [data?.items]);

  const filtered = useMemo(() => {
    let items = data?.items || [];
    if (severity !== 'all') items = items.filter((it) => it.severity === severity);
    if (planFilter !== 'all') items = items.filter((it) => it.planName === planFilter);
    return items.slice().sort((a, b) => {
      const r = SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity];
      if (r !== 0) return r;
      return b.createdAt.localeCompare(a.createdAt);
    });
  }, [data?.items, severity, planFilter]);

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-4">
        <h1 className="text-page-title">Inbox</h1>
        <div className="text-sm text-muted-foreground">
          {data ? `${data.unresolvedCount} unresolved · ${data.total} total` : '…'}
        </div>
      </div>

      <div className="flex flex-wrap gap-2 items-center">
        <span className="text-xs text-muted-foreground">severity:</span>
        {(['all', 'critical', 'high', 'medium', 'low'] as const).map((s) => (
          <button
            key={s}
            onClick={() => setSeverity(s)}
            className={`text-xs px-2 py-1 rounded border ${
              severity === s
                ? 'bg-primary text-primary-foreground border-primary'
                : 'bg-background border-border hover:bg-muted'
            }`}
          >
            {s}
          </button>
        ))}
        <span className="text-xs text-muted-foreground ml-4">plan:</span>
        <select
          value={planFilter}
          onChange={(e) => setPlanFilter(e.target.value)}
          className="text-xs px-2 py-1 rounded border bg-background"
        >
          {planNames.map((n) => (
            <option key={n} value={n}>
              {n === 'all' ? 'All plans' : n}
            </option>
          ))}
        </select>
        <label className="ml-4 text-xs flex items-center gap-1">
          <input
            type="checkbox"
            checked={showResolved}
            onChange={(e) => setShowResolved(e.target.checked)}
          />
          Show resolved
        </label>
      </div>

      {isLoading && <div className="text-sm text-muted-foreground">Loading inbox…</div>}

      {filtered.length === 0 && !isLoading && (
        <div className="rounded border border-dashed p-8 text-center text-sm text-muted-foreground">
          No items match. Inbox is clear.
        </div>
      )}

      <div className="space-y-2">
        {filtered.map((item) => (
          <div
            key={`${item.planId}/${item.itemId}`}
            className="rounded-lg border bg-card p-3 space-y-2"
          >
            <div className="flex items-center justify-between gap-2">
              <div className="flex items-center gap-2 flex-wrap">
                <SeverityBadge severity={item.severity} />
                <span className="text-sm font-medium">{item.title}</span>
                {item.planName && (
                  <span className="text-xs text-muted-foreground">in plan: {item.planName}</span>
                )}
                <Badge variant="outline" className="text-[10px]">
                  {item.category}
                </Badge>
              </div>
              <div className="text-xs text-muted-foreground">
                {new Date(item.createdAt).toLocaleString()}
              </div>
            </div>
            {item.body && (
              <p className="text-sm text-muted-foreground whitespace-pre-wrap line-clamp-3">
                {item.body}
              </p>
            )}
            <div className="flex flex-wrap gap-2">
              {item.context.epicId && (
                <a
                  href={`/labs?planId=${encodeURIComponent(item.planId)}`}
                  className="text-xs underline text-primary"
                >
                  Open plan
                </a>
              )}
              {item.status !== 'resolved' && (
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => resolve.mutate({ planId: item.planId, itemId: item.itemId })}
                  disabled={resolve.isPending}
                >
                  Mark resolved
                </Button>
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function SeverityBadge({ severity }: { severity: AttentionSeverity }) {
  const styles: Record<AttentionSeverity, string> = {
    critical: 'bg-destructive text-destructive-foreground',
    high: 'border-destructive text-destructive',
    medium: 'border-warning text-warning',
    low: 'border-border text-muted-foreground',
  };
  return (
    <Badge variant="outline" className={`text-[10px] ${styles[severity]}`}>
      {severity}
    </Badge>
  );
}

export default function InboxPage() {
  return (
    <AuthGuard>
      <AppShell>
        <InboxContent />
      </AppShell>
    </AuthGuard>
  );
}
