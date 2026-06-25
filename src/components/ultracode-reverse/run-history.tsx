'use client';

import { Loader2, X } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';
import { useUltracodeRuns, useDeleteUltracodeRun } from '@/hooks/use-ultracode-runs';
import { ACTIVE_STATUSES, type UltracodeRunStatus } from '@/types/ultracode-run';

function statusVariant(s: UltracodeRunStatus): 'default' | 'secondary' | 'destructive' | 'outline' {
  if (s === 'COMPLETE') return 'default';
  if (s === 'ERROR') return 'destructive';
  if (s === 'QUEUED') return 'outline';
  return 'secondary';
}

/** Human label for a corpus badge (active states read as live progress). */
function statusLabel(s: UltracodeRunStatus): string {
  switch (s) {
    case 'QUEUED':
      return 'queued';
    case 'CAPTURING':
      return 'capturing…';
    case 'SCORING':
      return 'scoring…';
    case 'COMPLETE':
      return 'complete';
    case 'ERROR':
      return 'failed';
    default:
      return s.toLowerCase();
  }
}

export function RunHistory({
  activeRunId,
  onSelect,
}: {
  activeRunId: string | null;
  onSelect(runId: string): void;
}) {
  const { data, isLoading } = useUltracodeRuns();
  const del = useDeleteUltracodeRun();
  const runs = data?.runs ?? [];
  const failed = runs.filter((r) => r.status === 'ERROR');

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between gap-2 space-y-0">
        <CardTitle>Corpus</CardTitle>
        {failed.length > 0 && (
          <button
            onClick={() => failed.forEach((r) => del.mutate(r.runId))}
            className="rounded px-1.5 py-0.5 text-xs text-muted-foreground hover:bg-muted hover:text-destructive"
            title="Remove all failed runs"
          >
            Clear failed ({failed.length})
          </button>
        )}
      </CardHeader>
      <CardContent className="space-y-2">
        {isLoading ? (
          <>
            <Skeleton className="h-10 w-full" />
            <Skeleton className="h-10 w-full" />
          </>
        ) : runs.length === 0 ? (
          <p className="text-sm text-muted-foreground">No runs yet — submit an intent to start.</p>
        ) : (
          runs.map((r) => {
            const active = ACTIVE_STATUSES.has(r.status);
            return (
              <div
                key={r.runId}
                className={cn(
                  'group relative flex w-full items-start gap-2 rounded-md border border-border px-3 py-2 transition-colors hover:bg-muted/50',
                  activeRunId === r.runId && 'border-primary bg-muted/50',
                )}
              >
                <button
                  onClick={() => onSelect(r.runId)}
                  className="min-w-0 flex-1 text-left"
                  aria-label={`Open run: ${r.intent}`}
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="truncate text-sm">{r.intent}</span>
                    <Badge
                      variant={statusVariant(r.status)}
                      className="flex shrink-0 items-center gap-1"
                    >
                      {active && <Loader2 className="h-3 w-3 animate-spin" />}
                      {statusLabel(r.status)}
                    </Badge>
                  </div>
                  <div className="mt-1 flex items-center gap-3 text-xs text-muted-foreground">
                    <span>{r.rigor}</span>
                    {r.structuralScore != null && (
                      <span className="tabular-nums">struct {r.structuralScore.toFixed(2)}</span>
                    )}
                    {r.guardrailUplift != null && (
                      <span className="tabular-nums">guard {r.guardrailUplift.toFixed(2)}</span>
                    )}
                    {r.verdict && <span>{r.verdict}</span>}
                  </div>
                </button>
                {/* Dismiss — only for runs that aren't actively working, so we never kill a live row. */}
                {!active && (
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      del.mutate(r.runId);
                    }}
                    title="Remove this run"
                    aria-label="Remove this run"
                    className="mt-0.5 shrink-0 rounded p-1 text-muted-foreground opacity-60 transition-opacity hover:bg-muted hover:text-destructive hover:opacity-100"
                  >
                    <X className="h-3.5 w-3.5" />
                  </button>
                )}
              </div>
            );
          })
        )}
      </CardContent>
    </Card>
  );
}
