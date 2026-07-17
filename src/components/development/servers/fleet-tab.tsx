'use client';
import { useState } from 'react';
import { useServers } from '@/hooks/use-servers';
import { Button } from '@/components/ui/button';
import { TooltipProvider } from '@/components/ui/tooltip';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { ServerCard } from './server-card';
import { AddServerWizard } from './add-server-wizard';

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
  const [wizardOpen, setWizardOpen] = useState(false);
  const servers = (data?.servers ?? []).filter((s) => s.status !== 'DELETED');

  const totalActive = servers.reduce((sum, s) => sum + (s.activeCount ?? 0), 0);
  const enabled = servers.filter((s) => s.enabled);
  const totalCapacity = enabled.reduce((sum, s) => sum + s.maxConcurrent, 0);
  const costPerHour = enabled.reduce((sum, s) => sum + s.costPerHour, 0);

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3">
        {isLoading || error ? (
          <span />
        ) : (
          <SummaryStrip
            totalActive={totalActive}
            totalCapacity={totalCapacity}
            costPerHour={costPerHour}
          />
        )}
        <Button size="sm" onClick={() => setWizardOpen(true)}>
          + Add Server
        </Button>
      </div>

      {isLoading && <p className="text-sm text-muted-foreground">Loading fleet…</p>}

      {error && (
        <div className="rounded-lg border border-destructive/30 bg-destructive/5 p-4 text-sm text-destructive">
          Failed to load servers: {(error as Error).message}
        </div>
      )}

      {!isLoading && !error && servers.length === 0 && (
        <div className="rounded-md border border-dashed border-border p-8 text-center">
          <p className="text-sm text-muted-foreground">
            No servers yet — add a cloud provider or enrol a machine you own.
          </p>
          <Button size="sm" className="mt-3" onClick={() => setWizardOpen(true)}>
            + Add Server
          </Button>
        </div>
      )}

      {!isLoading && !error && servers.length > 0 && (
        <TooltipProvider>
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3">
            {servers.map((server) => (
              <ServerCard key={server.serverId} server={server} />
            ))}
          </div>
        </TooltipProvider>
      )}

      <Dialog open={wizardOpen} onOpenChange={setWizardOpen}>
        <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-3xl">
          <DialogHeader>
            <DialogTitle>Add server</DialogTitle>
            <DialogDescription>
              Provision a cloud VM or enrol a machine you own. It joins the fleet and the dispatcher
              starts assigning it work once its daemon reports in.
            </DialogDescription>
          </DialogHeader>
          <AddServerWizard onClose={() => setWizardOpen(false)} />
        </DialogContent>
      </Dialog>
    </div>
  );
}
