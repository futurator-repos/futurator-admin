'use client';
import { useEffect, useMemo, useState } from 'react';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { cn } from '@/lib/utils';
import { useServers, heartbeatState } from '@/hooks/use-servers';
import type { ComputeServer } from '@/types/servers';

const PROVIDER_LABEL: Record<ComputeServer['provider'], string> = {
  hetzner: 'Hetzner',
  oracle: 'Oracle',
  gcp: 'GCP',
  aws: 'AWS',
  local: 'Local',
};

const HEARTBEAT_DOT_CLASS: Record<ReturnType<typeof heartbeatState>, string> = {
  fresh: 'bg-success',
  stale: 'bg-warning',
  dead: 'bg-destructive',
};

function secondsAgo(iso: string | undefined, now: number): number | null {
  if (!iso) return null;
  return Math.max(0, Math.round((now - new Date(iso).getTime()) / 1000));
}

/** A labelled horizontal gauge. `tone` colours the fill; `pct` clamps to 0–100. */
function Gauge({
  label,
  valueText,
  pct,
  tone,
}: {
  label: string;
  valueText: string;
  pct: number;
  tone: 'accent-blue' | 'success' | 'warning';
}) {
  const clamped = Math.min(100, Math.max(0, pct));
  const fill =
    tone === 'warning' ? 'bg-warning' : tone === 'success' ? 'bg-success' : 'bg-accent-blue';
  return (
    <div className="space-y-1.5">
      <div className="flex items-baseline justify-between">
        <span className="text-xs text-muted-foreground">{label}</span>
        <span className="font-mono text-xs tabular-nums">{valueText}</span>
      </div>
      <div className="h-2 w-full overflow-hidden rounded-full bg-muted">
        <div
          className={cn('h-full rounded-full transition-all', fill)}
          style={{ width: `${clamped}%` }}
        />
      </div>
    </div>
  );
}

function AuthBadge({ server }: { server: ComputeServer }) {
  const auth = server.auth;
  if (!auth) {
    return (
      <Badge variant="outline" className="opacity-70">
        auth unknown
      </Badge>
    );
  }
  return (
    <Badge
      variant="outline"
      className={cn(
        auth.valid ? 'border-success text-success' : 'border-destructive text-destructive',
      )}
    >
      {auth.valid ? 'auth valid' : 'auth invalid'}
      {auth.subscriptionType ? ` · ${auth.subscriptionType}` : ''}
    </Badge>
  );
}

/** Live gauges for one reporting server, derived entirely from the heartbeat
 * `system`/`auth`/slot fields the daemon already writes — no backend change. */
function ServerGauges({ server, now }: { server: ComputeServer; now: number }) {
  const sys = server.system;
  const memPct =
    sys && sys.totalMem > 0 ? ((sys.totalMem - sys.freeMem) / sys.totalMem) * 100 : null;
  const load1 = sys?.loadAvg?.[0];
  const activeCount = server.activeCount ?? 0;
  const slotPct = server.maxConcurrent > 0 ? (activeCount / server.maxConcurrent) * 100 : 0;

  return (
    <Card className="space-y-4 p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <span className="text-xs uppercase tracking-wide text-muted-foreground">
            {PROVIDER_LABEL[server.provider]}
          </span>
          <h3 className="text-sm font-semibold">{server.name}</h3>
        </div>
        <AuthBadge server={server} />
      </div>

      {memPct === null ? (
        <p className="text-xs text-muted-foreground">
          Reporting in, but this daemon has not published system metrics yet.
        </p>
      ) : (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
          <Gauge
            label="RAM used"
            valueText={`${memPct.toFixed(0)}%`}
            pct={memPct}
            tone={memPct > 90 ? 'warning' : 'accent-blue'}
          />
          <Gauge
            label="Load (1m)"
            valueText={load1 === undefined ? '—' : load1.toFixed(2)}
            // A load average of 1.0 per core is "fully busy"; normalise the bar
            // against the cap as a rough slot-pressure proxy since core count
            // is not reported.
            pct={load1 === undefined ? 0 : (load1 / Math.max(1, server.maxConcurrent)) * 100}
            tone="accent-blue"
          />
          <Gauge
            label="Slots"
            valueText={`${activeCount}/${server.maxConcurrent}`}
            pct={slotPct}
            tone={slotPct >= 100 ? 'warning' : 'success'}
          />
        </div>
      )}

      <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
        <span className="inline-block size-2 rounded-full bg-success" />
        <span>Heartbeat {secondsAgo(server.lastHeartbeatAt, now) ?? 0}s ago</span>
        {server.daemonVersion && (
          <span className="ml-2 font-mono text-[10px]">daemon {server.daemonVersion}</span>
        )}
      </div>
    </Card>
  );
}

/** Stale/dead server — the daemon has gone quiet, so gauges would be lying.
 * Show when it was last seen instead. */
function DeadServer({ server, now }: { server: ComputeServer; now: number }) {
  const state = heartbeatState(server.lastHeartbeatAt, now);
  const age = secondsAgo(server.lastHeartbeatAt, now);
  return (
    <Card className="space-y-3 p-6 text-center">
      <div className="flex items-center justify-center gap-2">
        <span className="text-xs uppercase tracking-wide text-muted-foreground">
          {PROVIDER_LABEL[server.provider]}
        </span>
        <h3 className="text-sm font-semibold">{server.name}</h3>
      </div>
      <div className="flex items-center justify-center gap-1.5 text-sm text-muted-foreground">
        <span className={cn('inline-block size-2 rounded-full', HEARTBEAT_DOT_CLASS[state])} />
        <span>
          {state === 'dead'
            ? `No heartbeat — last seen ${age === null ? 'never' : `${age}s ago`}`
            : `Heartbeat stale — last seen ${age === null ? 'never' : `${age}s ago`}`}
        </span>
      </div>
      <p className="text-xs text-muted-foreground">
        Live gauges appear once the daemon on this machine resumes reporting.
      </p>
    </Card>
  );
}

export function MonitoringTab() {
  const { data, isLoading, error } = useServers();
  const servers = useMemo(
    () => (data?.servers ?? []).filter((s) => s.status !== 'DELETED'),
    [data],
  );

  // The server the operator explicitly picked (if any). The *effective*
  // selection is derived during render below so it needs no sync effect.
  const [pickedId, setPickedId] = useState<string | undefined>(undefined);

  // One clock for the tab so freshness text ticks even between polls.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 5000);
    return () => clearInterval(id);
  }, []);

  if (isLoading) {
    return <p className="text-sm text-muted-foreground">Loading fleet…</p>;
  }

  if (error) {
    return (
      <div className="rounded-lg border border-destructive/30 bg-destructive/5 p-4 text-sm text-destructive">
        Failed to load servers: {(error as Error).message}
      </div>
    );
  }

  if (servers.length === 0) {
    return (
      <div className="rounded-md border border-dashed border-border p-8 text-center">
        <p className="text-sm text-muted-foreground">
          No servers to monitor yet — add one from the Fleet tab.
        </p>
      </div>
    );
  }

  // Honor the operator's pick while it still refers to a live row; otherwise
  // fall back to the first server (guaranteed present past the guard above).
  const selectedId =
    pickedId && servers.some((s) => s.serverId === pickedId) ? pickedId : servers[0].serverId;
  const selected = servers.find((s) => s.serverId === selectedId);
  const isLive = selected ? heartbeatState(selected.lastHeartbeatAt, now) === 'fresh' : false;

  return (
    <div className="space-y-4">
      <Select value={selectedId} onValueChange={(v) => v && setPickedId(v)}>
        <SelectTrigger className="w-full sm:w-72">
          <SelectValue placeholder="Select a server" />
        </SelectTrigger>
        <SelectContent>
          {servers.map((s) => (
            <SelectItem key={s.serverId} value={s.serverId}>
              {PROVIDER_LABEL[s.provider]} · {s.name}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>

      {selected &&
        (isLive ? (
          <ServerGauges server={selected} now={now} />
        ) : (
          <DeadServer server={selected} now={now} />
        ))}
    </div>
  );
}
