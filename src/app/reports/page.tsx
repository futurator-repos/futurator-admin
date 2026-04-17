'use client';
import { useState } from 'react';
import { AppShell } from '@/components/layout/app-shell';
import { AuthGuard } from '@/components/auth/auth-guard';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { useOrchestratorMetrics, type MetricsQuery } from '@/hooks/use-orchestrator-metrics';

function formatMs(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return '—';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)}s`;
  const m = s / 60;
  if (m < 60) return `${m.toFixed(1)}m`;
  return `${(m / 60).toFixed(1)}h`;
}

function formatUsd(n: number): string {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits: 4,
  }).format(n);
}

export default function ReportsPage() {
  const [range, setRange] = useState<'7d' | '30d' | 'all'>('30d');
  const [mode, setMode] = useState<'all' | 'orchestrator' | 'legacy'>('all');

  const query: MetricsQuery = {};
  if (range !== 'all') query.from = range; // "7d" | "30d" — resolved inside the hook
  if (mode === 'orchestrator') query.useEpicOrchestrator = 'true';
  if (mode === 'legacy') query.useEpicOrchestrator = 'false';

  const { data, isLoading } = useOrchestratorMetrics(query);
  const m = data?.metrics;

  return (
    <AuthGuard>
      <AppShell>
        <div className="space-y-6">
          <div className="flex items-center justify-between">
            <h1 className="text-page-title">Epic Orchestrator Metrics</h1>
            <div className="flex gap-2">
              {(['7d', '30d', 'all'] as const).map((r) => (
                <button
                  key={r}
                  onClick={() => setRange(r)}
                  className={`rounded-md px-3 py-1 text-sm ${range === r ? 'bg-primary text-primary-foreground' : 'bg-muted text-muted-foreground hover:bg-accent hover:text-accent-foreground'}`}
                >
                  {r === 'all' ? 'All time' : `Last ${r === '7d' ? '7' : '30'}d`}
                </button>
              ))}
              <span className="mx-2 text-muted-foreground">|</span>
              {(
                [
                  ['all', 'All'],
                  ['orchestrator', 'Orchestrator'],
                  ['legacy', 'Legacy'],
                ] as const
              ).map(([k, label]) => (
                <button
                  key={k}
                  onClick={() => setMode(k)}
                  className={`rounded-md px-3 py-1 text-sm ${mode === k ? 'bg-primary text-primary-foreground' : 'bg-muted text-muted-foreground hover:bg-accent hover:text-accent-foreground'}`}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>

          {isLoading ? (
            <div className="grid gap-4 md:grid-cols-3">
              {Array.from({ length: 4 }).map((_, i) => (
                <Skeleton key={i} className="h-32 rounded-lg" />
              ))}
            </div>
          ) : m ? (
            <>
              <div className="grid gap-4 md:grid-cols-3">
                <Card>
                  <CardHeader className="pb-2">
                    <CardTitle className="text-sm text-muted-foreground">
                      Epic wall-clock ({m.epic.count})
                    </CardTitle>
                  </CardHeader>
                  <CardContent>
                    <div className="text-2xl font-semibold">{formatMs(m.epic.medianMs)}</div>
                    <div className="text-xs text-muted-foreground">
                      median · p95 {formatMs(m.epic.p95Ms)}
                    </div>
                  </CardContent>
                </Card>

                <Card>
                  <CardHeader className="pb-2">
                    <CardTitle className="text-sm text-muted-foreground">
                      Story wall-clock ({m.story.count})
                    </CardTitle>
                  </CardHeader>
                  <CardContent>
                    <div className="text-2xl font-semibold">{formatMs(m.story.medianMs)}</div>
                    <div className="text-xs text-muted-foreground">
                      median · p95 {formatMs(m.story.p95Ms)}
                    </div>
                  </CardContent>
                </Card>

                <Card>
                  <CardHeader className="pb-2">
                    <CardTitle className="text-sm text-muted-foreground">
                      Remediation rate
                    </CardTitle>
                  </CardHeader>
                  <CardContent>
                    <div className="text-2xl font-semibold">
                      {(m.remediation.rate * 100).toFixed(1)}%
                    </div>
                    <div className="text-xs text-muted-foreground">
                      {m.remediation.epicsWithRemediations} / {m.remediation.epicsTotal} epics
                    </div>
                  </CardContent>
                </Card>
              </div>

              <Card>
                <CardHeader className="pb-2">
                  <CardTitle className="text-sm text-muted-foreground">
                    Token spend by tier
                  </CardTitle>
                </CardHeader>
                <CardContent>
                  <div className="grid grid-cols-4 gap-4">
                    {(['opus', 'sonnet', 'haiku', 'unknown'] as const).map((tier) => (
                      <div key={tier}>
                        <div className="text-xs uppercase text-muted-foreground">{tier}</div>
                        <div className="text-lg font-semibold">{formatUsd(m.tokenSpend[tier])}</div>
                      </div>
                    ))}
                  </div>
                </CardContent>
              </Card>

              <Card>
                <CardHeader className="pb-2">
                  <CardTitle className="text-sm text-muted-foreground">Blocker taxonomy</CardTitle>
                </CardHeader>
                <CardContent>
                  {Object.keys(m.blockerTaxonomy).length === 0 ? (
                    <div className="text-sm text-muted-foreground">No blockers in this range.</div>
                  ) : (
                    <ul className="space-y-1">
                      {Object.entries(m.blockerTaxonomy)
                        .sort((a, b) => b[1] - a[1])
                        .map(([code, count]) => (
                          <li key={code} className="flex justify-between text-sm">
                            <span>{code}</span>
                            <span className="font-mono">{count}</span>
                          </li>
                        ))}
                    </ul>
                  )}
                </CardContent>
              </Card>

              <div className="text-xs text-muted-foreground">
                Aggregated from {m.sampleSize} events in window.
              </div>
            </>
          ) : (
            <div className="text-muted-foreground">No metrics available.</div>
          )}
        </div>
      </AppShell>
    </AuthGuard>
  );
}
