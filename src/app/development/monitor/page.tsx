'use client';
import { useMemo, useState } from 'react';
import { AppShell } from '@/components/layout/app-shell';
import { AuthGuard } from '@/components/auth/auth-guard';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { useEc2Metrics, useEc2Snapshot } from '@/hooks/use-ec2-metrics';
import { useEc2Status, useSetEc2Cap } from '@/hooks/use-ec2-daemon';
import { useQueryClient } from '@tanstack/react-query';
import { MetricChart } from '@/components/development/servers/metric-chart';

const RANGES = [
  { value: '1h', label: '1 Hour' },
  { value: '3h', label: '3 Hours' },
  { value: '6h', label: '6 Hours' },
  { value: '24h', label: '24 Hours' },
];

/**
 * Queues module — editable concurrency cap. This is the SINGLE ceiling shared by
 * pipeline dev, Debates/Party, the free-agent chat, and inbound queue calls. The
 * daemon applies a change within ~5s (no restart). EC2 and Local caps are stored
 * independently; the daemon that's running reads the one for its source.
 */
function CapControl({
  label,
  target,
  value,
  effective,
}: {
  label: string;
  target: 'ec2' | 'local';
  value: number | null;
  effective?: number;
}) {
  const setCap = useSetEc2Cap();
  const current = value ?? effective ?? (target === 'ec2' ? 2 : 3);
  const commit = (next: number) => {
    const clamped = Math.max(1, Math.min(16, next));
    if (clamped === current) return;
    setCap.mutate({ target, maxConcurrent: clamped });
  };
  return (
    <div className="flex items-center gap-1.5">
      <span className="text-[10px] uppercase text-muted-foreground">{label}</span>
      <div className="flex items-center rounded-md border border-input overflow-hidden">
        <button
          onClick={() => commit(current - 1)}
          disabled={setCap.isPending || current <= 1}
          className="px-2 py-0.5 text-xs hover:bg-accent disabled:opacity-40"
          aria-label={`Decrease ${label} cap`}
        >
          −
        </button>
        <span className="px-2 text-xs font-mono tabular-nums min-w-[1.5rem] text-center">
          {setCap.isPending ? '…' : current}
        </span>
        <button
          onClick={() => commit(current + 1)}
          disabled={setCap.isPending || current >= 16}
          className="px-2 py-0.5 text-xs hover:bg-accent disabled:opacity-40"
          aria-label={`Increase ${label} cap`}
        >
          +
        </button>
      </div>
    </div>
  );
}

export default function MonitorPage() {
  return (
    <AuthGuard>
      <AppShell>
        <MonitorContent />
      </AppShell>
    </AuthGuard>
  );
}

function MonitorContent() {
  const [range, setRange] = useState('1h');
  const queryClient = useQueryClient();

  const { data: ec2Status, error: statusError } = useEc2Status(true);

  const isRunning = ec2Status?.state === 'running';
  const isPending = ec2Status?.state === 'pending';

  const { data: metrics, isFetching: metricsFetching } = useEc2Metrics(range, isRunning);
  const { data: snapshotData, isFetching: snapshotFetching } = useEc2Snapshot(isRunning);
  const snapshot = snapshotData?.snapshot;

  // Capture current time once per data refresh so we avoid calling Date.now()
  // during render (impure). The value updates whenever ec2Status changes.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const now = useMemo(() => Date.now(), [ec2Status]);

  const refresh = () => {
    queryClient.invalidateQueries({ queryKey: ['ec2-metrics'] });
    queryClient.invalidateQueries({ queryKey: ['ec2-snapshot'] });
  };

  return (
    <div className="space-y-4">
      {/* Runtime panels live in the global app header. Page-level title
          shows the IP for quick reference. */}
      <div className="flex items-center justify-between gap-4">
        <h1 className="text-page-title">EC2 Monitor</h1>
        {ec2Status?.publicIp && (
          <span className="text-xs text-muted-foreground font-mono">{ec2Status.publicIp}</span>
        )}
      </div>

      {statusError && (
        <Card className="border-red-900/60">
          <CardContent className="pt-4">
            <p className="text-xs text-red-400">
              Failed to load EC2 status: {(statusError as Error).message}
            </p>
          </CardContent>
        </Card>
      )}

      {!isRunning && !isPending && (
        <Card>
          <CardContent className="pt-6">
            <p className="text-sm text-muted-foreground">
              EC2 instance is not running. Toggle the daemon to <strong>EC2</strong> in the header
              to start it and verify auth.
            </p>
          </CardContent>
        </Card>
      )}

      {isPending && (
        <Card>
          <CardContent className="pt-6">
            <p className="text-sm text-yellow-500">
              EC2 instance is starting up... metrics will appear shortly.
            </p>
          </CardContent>
        </Card>
      )}

      {isRunning && (
        <>
          {/* Controls */}
          <div className="flex items-center gap-3">
            <div className="flex rounded-md border border-input overflow-hidden">
              {RANGES.map((r) => (
                <button
                  key={r.value}
                  onClick={() => setRange(r.value)}
                  className={`px-3 py-1 text-xs ${range === r.value ? 'bg-primary text-primary-foreground' : 'bg-background text-muted-foreground hover:bg-accent'}`}
                >
                  {r.label}
                </button>
              ))}
            </div>
            <button
              onClick={refresh}
              disabled={metricsFetching || snapshotFetching}
              className="rounded-md border border-input px-3 py-1 text-xs hover:bg-accent disabled:opacity-50"
            >
              {metricsFetching || snapshotFetching ? 'Loading...' : 'Refresh'}
            </button>
          </div>

          {/* Daemon Activity Panel */}
          <Card>
            <CardHeader className="pb-2">
              <div className="flex items-center justify-between">
                <CardTitle className="text-xs">Daemon Activity</CardTitle>
                <div className="flex items-center gap-3">
                  {ec2Status?.system && (
                    <span className="text-[10px] text-muted-foreground">
                      RAM{' '}
                      {Math.round(
                        ((ec2Status.system.totalMem - ec2Status.system.freeMem) /
                          ec2Status.system.totalMem) *
                          100,
                      )}
                      % ({ec2Status.system.freeMem}MB free / {ec2Status.system.totalMem}MB) &middot;
                      Load {ec2Status.system.loadAvg[0]}
                    </span>
                  )}
                  <span className="text-[10px] font-mono text-muted-foreground">
                    {ec2Status?.activeCount ?? 0} / {ec2Status?.maxConcurrent ?? 0} slots
                  </span>
                  <CapControl
                    label="EC2 cap"
                    target="ec2"
                    value={ec2Status?.ec2MaxConcurrent ?? null}
                    effective={ec2Status?.maxConcurrent}
                  />
                  <CapControl
                    label="Local cap"
                    target="local"
                    value={ec2Status?.localMaxConcurrent ?? null}
                  />
                </div>
              </div>
              <p className="mt-1 text-[10px] text-muted-foreground">
                Shared cap — pipeline, Debates, free-agent &amp; queue calls all draw from these
                slots. Changes apply to the running daemon within ~5s.
              </p>
            </CardHeader>
            <CardContent>
              {/* Concurrency bar */}
              <div className="h-2 rounded-full bg-muted overflow-hidden mb-3">
                <div
                  className={`h-full transition-all ${
                    (ec2Status?.activeCount ?? 0) >= (ec2Status?.maxConcurrent ?? 1)
                      ? 'bg-red-500'
                      : 'bg-green-500'
                  }`}
                  style={{
                    width: `${((ec2Status?.activeCount ?? 0) / Math.max(ec2Status?.maxConcurrent ?? 1, 1)) * 100}%`,
                  }}
                />
              </div>

              {!ec2Status?.processes || ec2Status.processes.length === 0 ? (
                <p className="text-xs text-muted-foreground italic">Idle — no active jobs</p>
              ) : (
                <div className="space-y-1.5">
                  {ec2Status.processes.map((proc) => {
                    const elapsed = proc.startedAt
                      ? Math.max(0, Math.floor((now - new Date(proc.startedAt).getTime()) / 1000))
                      : 0;
                    const mins = Math.floor(elapsed / 60);
                    const secs = elapsed % 60;
                    const dur = mins > 0 ? `${mins}m ${secs}s` : `${secs}s`;
                    return (
                      <div
                        key={proc.jobId}
                        className="flex items-center justify-between text-xs border border-border rounded px-2 py-1.5"
                      >
                        <div className="flex items-center gap-2">
                          <span className="h-2 w-2 rounded-full bg-green-500 animate-pulse" />
                          <span className="font-mono text-muted-foreground">{proc.jobId}</span>
                          <span className="text-foreground font-medium">{proc.workingDir}</span>
                        </div>
                        <div className="flex items-center gap-3 text-muted-foreground">
                          <span className="bg-muted px-1.5 py-0.5 rounded text-[10px]">
                            {proc.stepId || '—'}
                          </span>
                          <span className="text-[10px]">{proc.agentId || '—'}</span>
                          <span className="font-mono text-[10px]">{proc.model || '—'}</span>
                          <span className="font-mono text-[10px] tabular-nums">{dur}</span>
                          {proc.pid && (
                            <span className="text-[10px] text-muted-foreground/50">
                              PID {proc.pid}
                            </span>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </CardContent>
          </Card>

          {/* Metric charts */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-xs">CPU Utilization</CardTitle>
              </CardHeader>
              <CardContent>
                <MetricChart
                  label="CPU"
                  timestamps={metrics?.metrics.cpu?.timestamps || []}
                  values={metrics?.metrics.cpu?.values || []}
                  unit="%"
                  thresholds={{ warn: 60, crit: 85 }}
                />
              </CardContent>
            </Card>

            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-xs">Memory Usage</CardTitle>
              </CardHeader>
              <CardContent>
                <MetricChart
                  label="RAM"
                  timestamps={metrics?.metrics.mem?.timestamps || []}
                  values={metrics?.metrics.mem?.values || []}
                  unit="%"
                  thresholds={{ warn: 70, crit: 90 }}
                />
              </CardContent>
            </Card>

            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-xs">Disk Usage (/)</CardTitle>
              </CardHeader>
              <CardContent>
                <MetricChart
                  label="Disk"
                  timestamps={metrics?.metrics.disk?.timestamps || []}
                  values={metrics?.metrics.disk?.values || []}
                  unit="%"
                  thresholds={{ warn: 75, crit: 90 }}
                />
              </CardContent>
            </Card>

            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-xs">Network I/O</CardTitle>
              </CardHeader>
              <CardContent>
                <div className="space-y-3">
                  <MetricChart
                    label="In"
                    timestamps={metrics?.metrics.netin?.timestamps || []}
                    values={(metrics?.metrics.netin?.values || []).map((v) => v / (1024 * 1024))}
                    unit=" MB"
                  />
                  <MetricChart
                    label="Out"
                    timestamps={metrics?.metrics.netout?.timestamps || []}
                    values={(metrics?.metrics.netout?.values || []).map((v) => v / (1024 * 1024))}
                    unit=" MB"
                  />
                </div>
              </CardContent>
            </Card>
          </div>

          {/* Live snapshot */}
          <Card>
            <CardHeader className="pb-2">
              <div className="flex items-center justify-between">
                <CardTitle className="text-xs">Live Snapshot</CardTitle>
                <button
                  onClick={() => queryClient.invalidateQueries({ queryKey: ['ec2-snapshot'] })}
                  disabled={snapshotFetching}
                  className="text-[10px] text-muted-foreground hover:text-foreground disabled:opacity-50"
                >
                  {snapshotFetching ? 'Fetching...' : 'Refresh Snapshot'}
                </button>
              </div>
            </CardHeader>
            <CardContent>
              {!snapshot ? (
                <p className="text-xs text-muted-foreground">
                  Click Refresh Snapshot to fetch current state
                </p>
              ) : (
                <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                  <div>
                    <div className="text-[10px] text-muted-foreground uppercase">Daemon</div>
                    <div
                      className={`text-sm font-medium ${snapshot.daemonStatus === 'active' ? 'text-green-500' : 'text-red-500'}`}
                    >
                      {snapshot.daemonStatus}
                    </div>
                  </div>
                  <div>
                    <div className="text-[10px] text-muted-foreground uppercase">
                      Claude Processes
                    </div>
                    <div className="text-sm font-medium">{snapshot.claudeProcesses}</div>
                  </div>
                  <div>
                    <div className="text-[10px] text-muted-foreground uppercase">Uptime Since</div>
                    <div className="text-sm font-mono">{snapshot.uptimeSince}</div>
                  </div>
                  <div>
                    <div className="text-[10px] text-muted-foreground uppercase">Disk</div>
                    <div className="text-sm font-mono">{snapshot.disk}</div>
                  </div>
                </div>
              )}

              {snapshot?.memory && (
                <details className="mt-3">
                  <summary className="cursor-pointer text-[10px] text-muted-foreground hover:text-foreground">
                    Memory Details
                  </summary>
                  <pre className="mt-1 text-[10px] font-mono text-muted-foreground bg-muted/30 rounded p-2">
                    {snapshot.memory}
                  </pre>
                </details>
              )}

              {snapshot?.topProcesses && (
                <details className="mt-2">
                  <summary className="cursor-pointer text-[10px] text-muted-foreground hover:text-foreground">
                    Top Processes (by memory)
                  </summary>
                  <pre className="mt-1 text-[10px] font-mono text-muted-foreground bg-muted/30 rounded p-2 overflow-x-auto">
                    {snapshot.topProcesses}
                  </pre>
                </details>
              )}
            </CardContent>
          </Card>
        </>
      )}
    </div>
  );
}
