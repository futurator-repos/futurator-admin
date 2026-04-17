'use client';
import { useMemo, useState } from 'react';
import { AppShell } from '@/components/layout/app-shell';
import { AuthGuard } from '@/components/auth/auth-guard';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { useEc2Metrics, useEc2Snapshot } from '@/hooks/use-ec2-metrics';
import { useEc2Status, useDisableEc2, useStartAndVerify } from '@/hooks/use-ec2-daemon';
import { useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, CheckCircle2 } from 'lucide-react';

const RANGES = [
  { value: '1h', label: '1 Hour' },
  { value: '3h', label: '3 Hours' },
  { value: '6h', label: '6 Hours' },
  { value: '24h', label: '24 Hours' },
];

function MetricChart({
  label,
  timestamps,
  values,
  unit,
  thresholds,
}: {
  label: string;
  timestamps: string[];
  values: number[];
  unit: string;
  thresholds?: { warn: number; crit: number };
}) {
  if (timestamps.length === 0) {
    return <div className="text-xs text-muted-foreground italic">No data for this period</div>;
  }

  const max = Math.max(...values, thresholds?.crit || 100);
  const latest = values[values.length - 1];
  const avg = values.reduce((a, b) => a + b, 0) / values.length;
  const peak = Math.max(...values);

  const color = thresholds
    ? latest > thresholds.crit
      ? 'text-red-500'
      : latest > thresholds.warn
        ? 'text-yellow-500'
        : 'text-green-500'
    : 'text-blue-400';

  const barColor = thresholds
    ? latest > thresholds.crit
      ? 'bg-red-500'
      : latest > thresholds.warn
        ? 'bg-yellow-500'
        : 'bg-green-500'
    : 'bg-blue-500';

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <span className="text-xs font-medium">{label}</span>
        <div className="flex items-center gap-3 text-[10px] text-muted-foreground">
          <span>
            avg: {avg.toFixed(1)}
            {unit}
          </span>
          <span>
            peak: {peak.toFixed(1)}
            {unit}
          </span>
          <span className={`font-medium ${color}`}>
            now: {latest.toFixed(1)}
            {unit}
          </span>
        </div>
      </div>

      {/* Sparkline-style bar chart */}
      <div className="flex items-end gap-px h-16 bg-muted/20 rounded overflow-hidden">
        {values.map((v, i) => {
          const height = Math.max(1, (v / max) * 100);
          const isLast = i === values.length - 1;
          const bColor = thresholds
            ? v > thresholds.crit
              ? 'bg-red-500'
              : v > thresholds.warn
                ? 'bg-yellow-500'
                : 'bg-green-600'
            : 'bg-blue-500';
          return (
            <div
              key={i}
              className={`flex-1 min-w-[2px] ${bColor} ${isLast ? 'opacity-100' : 'opacity-70'} transition-all`}
              style={{ height: `${height}%` }}
              title={`${new Date(timestamps[i]).toLocaleTimeString()}: ${v.toFixed(1)}${unit}`}
            />
          );
        })}
      </div>

      {/* Current value bar */}
      {thresholds && (
        <div className="h-2 rounded-full bg-muted overflow-hidden">
          <div
            className={`h-full ${barColor} transition-all`}
            style={{ width: `${Math.min(100, (latest / max) * 100)}%` }}
          />
        </div>
      )}

      {/* Time range labels */}
      <div className="flex justify-between text-[9px] text-muted-foreground">
        <span>{timestamps.length > 0 ? new Date(timestamps[0]).toLocaleTimeString() : ''}</span>
        <span>
          {timestamps.length > 0
            ? new Date(timestamps[timestamps.length - 1]).toLocaleTimeString()
            : ''}
        </span>
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

  const { data: ec2Status, isLoading: statusLoading, error: statusError } = useEc2Status(true);
  const startVerify = useStartAndVerify();
  const disableEc2 = useDisableEc2();

  const isRunning = ec2Status?.state === 'running';
  const isPending = ec2Status?.state === 'pending';
  const isStopping = ec2Status?.state === 'stopping';
  const isTransitioning = isPending || isStopping || startVerify.isRunning || disableEc2.isPending;
  const authValid = ec2Status?.auth?.valid;
  const authBroken = isRunning && authValid === false;

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

  const handleToggleEc2 = () => {
    if (isRunning) {
      disableEc2.mutate(undefined);
    } else {
      startVerify.reset();
      startVerify.run();
    }
  };

  const displayState = statusLoading
    ? 'loading'
    : statusError
      ? 'error'
      : ec2Status?.state || 'unknown';

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <h1 className="text-page-title">EC2 Monitor</h1>
        <div className="flex items-center gap-3">
          {/* Instance status badge */}
          <span
            className={`rounded px-2 py-0.5 text-xs font-medium ${
              isRunning
                ? 'bg-green-900 text-green-400'
                : isPending || isStopping
                  ? 'bg-yellow-900 text-yellow-400'
                  : statusError
                    ? 'bg-red-900 text-red-400'
                    : 'bg-muted text-muted-foreground'
            }`}
            title={statusError ? (statusError as Error).message : undefined}
          >
            {displayState}
          </span>
          {isRunning && ec2Status?.daemonAlive && (
            <span className="rounded px-2 py-0.5 text-[10px] font-mono bg-green-900/40 text-green-400">
              daemon ✓
            </span>
          )}
          {isRunning && ec2Status && !ec2Status.daemonAlive && (
            <span className="rounded px-2 py-0.5 text-[10px] font-mono bg-yellow-900/40 text-yellow-400">
              daemon down
            </span>
          )}
          {authValid === true && (
            <span
              className="flex items-center gap-1 rounded px-2 py-0.5 text-[10px] font-mono bg-green-900/40 text-green-400"
              title="Claude Code auth probe OK"
            >
              <CheckCircle2 className="h-3 w-3" /> auth
            </span>
          )}
          {authBroken && (
            <span
              className="flex items-center gap-1 rounded px-2 py-0.5 text-[10px] font-mono bg-red-900/40 text-red-400"
              title={ec2Status?.auth?.error || 'Auth probe failed'}
            >
              <AlertTriangle className="h-3 w-3" /> auth expired
            </span>
          )}
          {ec2Status?.publicIp && (
            <span className="text-xs text-muted-foreground font-mono">{ec2Status.publicIp}</span>
          )}
          {/* Start & Verify / Stop toggle */}
          <button
            onClick={handleToggleEc2}
            disabled={isTransitioning}
            className={`rounded-md px-3 py-1 text-xs font-medium transition-colors disabled:opacity-50 disabled:cursor-not-allowed ${
              isRunning
                ? 'bg-red-900/60 text-red-400 hover:bg-red-900'
                : 'bg-green-900/60 text-green-400 hover:bg-green-900'
            }`}
            title={startVerify.isRunning ? startVerify.detail : undefined}
          >
            {startVerify.isRunning
              ? startVerify.step.replace('-', ' ') + '…'
              : isPending
                ? 'Starting…'
                : isStopping
                  ? 'Stopping…'
                  : disableEc2.isPending
                    ? 'Stopping…'
                    : isRunning
                      ? 'Stop Instance'
                      : 'Start & Verify'}
          </button>
        </div>
      </div>

      {/* Orchestrated flow status banner */}
      {startVerify.isRunning && (
        <Card>
          <CardContent className="pt-4 space-y-1">
            <p className="text-xs text-yellow-500 font-medium">
              {startVerify.step.replace('-', ' ')}
            </p>
            <p className="text-[11px] text-muted-foreground">{startVerify.detail}</p>
          </CardContent>
        </Card>
      )}
      {startVerify.step === 'error' && (
        <Card className="border-red-900">
          <CardContent className="pt-4 space-y-2">
            <p className="text-xs text-red-400 font-medium">Start & Verify failed</p>
            <p className="text-[11px] text-muted-foreground">{startVerify.error}</p>
            <button
              onClick={() => {
                startVerify.reset();
                startVerify.run();
              }}
              className="rounded-md bg-red-900 px-3 py-1 text-xs text-red-100 hover:bg-red-800"
            >
              Retry
            </button>
          </CardContent>
        </Card>
      )}
      {startVerify.step === 'done' && (
        <Card className="border-green-900/60">
          <CardContent className="pt-4">
            <p className="text-xs text-green-400 font-medium flex items-center gap-1">
              <CheckCircle2 className="h-3 w-3" />
              Daemon running and Claude authorized.
            </p>
          </CardContent>
        </Card>
      )}
      {statusError && !startVerify.isRunning && (
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
              EC2 instance is not running. Click &ldquo;Start Instance&rdquo; above to see metrics.
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
                </div>
              </div>
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
