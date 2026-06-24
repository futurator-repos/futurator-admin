'use client';

import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';
import { useUltracodeRuns } from '@/hooks/use-ultracode-runs';
import type { UltracodeRunStatus } from '@/types/ultracode-run';

function statusVariant(s: UltracodeRunStatus): 'default' | 'secondary' | 'destructive' | 'outline' {
  if (s === 'COMPLETE') return 'default';
  if (s === 'ERROR') return 'destructive';
  if (s === 'QUEUED') return 'outline';
  return 'secondary';
}

export function RunHistory({
  activeRunId,
  onSelect,
}: {
  activeRunId: string | null;
  onSelect(runId: string): void;
}) {
  const { data, isLoading } = useUltracodeRuns();
  const runs = data?.runs ?? [];

  return (
    <Card>
      <CardHeader>
        <CardTitle>Corpus</CardTitle>
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
          runs.map((r) => (
            <button
              key={r.runId}
              onClick={() => onSelect(r.runId)}
              className={cn(
                'w-full rounded-md border border-border px-3 py-2 text-left transition-colors hover:bg-muted/50',
                activeRunId === r.runId && 'border-primary bg-muted/50',
              )}
            >
              <div className="flex items-center justify-between gap-2">
                <span className="truncate text-sm">{r.intent}</span>
                <Badge variant={statusVariant(r.status)} className="shrink-0">
                  {r.status.toLowerCase()}
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
          ))
        )}
      </CardContent>
    </Card>
  );
}
