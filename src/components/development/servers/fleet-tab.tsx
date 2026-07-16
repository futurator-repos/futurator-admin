'use client';
import { useServers } from '@/hooks/use-servers';
import { ServerCard } from './server-card';

function SummaryStrip({
  totalActive,
  totalCapacity,
  costPerHour,
}: {
  totalActive: number;
  totalCapacity: number;
  costPerHour: number;
}) {
  return (
    <div className="flex flex-wrap items-center gap-4 rounded-md border border-border px-3 py-2 text-xs">
      <span>
        <span className="text-muted-foreground">Active jobs</span>{' '}
        <span className="font-mono tabular-nums">{totalActive}</span>
      </span>
      <span>
        <span className="text-muted-foreground">Capacity</span>{' '}
        <span className="font-mono tabular-nums">{totalCapacity}</span>
      </span>
      <span>
        <span className="text-muted-foreground">Fleet cost</span>{' '}
        <span className="font-mono tabular-nums">${costPerHour.toFixed(2)}/hr</span>
      </span>
    </div>
  );
}

export function FleetTab() {
  const { data, isLoading, error } = useServers();
  const servers = (data?.servers ?? []).filter((s) => s.status !== 'DELETED');

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
      <div className="rounded-md border border-dashed border-border p-8 text-center text-sm text-muted-foreground">
        No servers — add one in Add Service.
      </div>
    );
  }

  const totalActive = servers.reduce((sum, s) => sum + (s.activeCount ?? 0), 0);
  const enabled = servers.filter((s) => s.enabled);
  const totalCapacity = enabled.reduce((sum, s) => sum + s.maxConcurrent, 0);
  const costPerHour = enabled.reduce((sum, s) => sum + s.costPerHour, 0);

  return (
    <div className="space-y-4">
      <SummaryStrip
        totalActive={totalActive}
        totalCapacity={totalCapacity}
        costPerHour={costPerHour}
      />
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3">
        {servers.map((server) => (
          <ServerCard key={server.serverId} server={server} />
        ))}
      </div>
    </div>
  );
}
