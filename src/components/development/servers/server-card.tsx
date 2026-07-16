'use client';
import { useEffect, useState } from 'react';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Switch } from '@/components/ui/switch';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogTitle,
  AlertDialogDescription,
} from '@/components/ui/alert-dialog';
import { cn } from '@/lib/utils';
import { useServerAction, useUpdateServer, heartbeatState } from '@/hooks/use-servers';
import type { ComputeServer, ComputeServerStatus } from '@/types/servers';

const MIN_CAP = 1;
const MAX_CAP = 16;

const PROVIDER_LABEL: Record<ComputeServer['provider'], string> = {
  hetzner: 'Hetzner',
  oracle: 'Oracle',
  gcp: 'GCP',
  aws: 'AWS',
  local: 'Local',
};

const STATUS_VARIANT: Record<
  ComputeServerStatus,
  { variant: 'default' | 'secondary' | 'destructive' | 'outline'; className: string }
> = {
  ACTIVE: { variant: 'outline', className: 'border-success text-success' },
  ERROR: { variant: 'destructive', className: '' },
  PROVISIONING: { variant: 'outline', className: 'border-warning text-warning' },
  BOOTSTRAPPING: { variant: 'outline', className: 'border-warning text-warning' },
  PAUSED: { variant: 'secondary', className: 'opacity-70' },
  DEPROVISIONING: { variant: 'secondary', className: 'opacity-70' },
  DELETED: { variant: 'secondary', className: 'opacity-50' },
};

function StatusBadge({ status }: { status: ComputeServerStatus }) {
  const cfg = STATUS_VARIANT[status] ?? STATUS_VARIANT.PAUSED;
  return (
    <Badge variant={cfg.variant} className={cn(cfg.className)}>
      {status}
    </Badge>
  );
}

const HEARTBEAT_DOT_CLASS: Record<ReturnType<typeof heartbeatState>, string> = {
  fresh: 'bg-success',
  stale: 'bg-warning',
  dead: 'bg-destructive',
};

function secondsAgo(iso: string | undefined, now: number): number | null {
  if (!iso) return null;
  return Math.max(0, Math.round((now - new Date(iso).getTime()) / 1000));
}

function HeartbeatIndicator({ server }: { server: ComputeServer }) {
  // Ticks every 5s so "last seen Xs ago" and the fresh/stale/dead dot stay
  // live without a manual refresh (the fleet itself already polls at 5s).
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 5000);
    return () => clearInterval(id);
  }, []);
  const state = heartbeatState(server.lastHeartbeatAt, now);
  const age = secondsAgo(server.lastHeartbeatAt, now);
  return (
    <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
      <span
        aria-label={`heartbeat: ${state}`}
        className={cn('inline-block size-2 rounded-full', HEARTBEAT_DOT_CLASS[state])}
      />
      {state === 'dead' ? (
        <span>last seen {age === null ? 'never' : `${age}s ago`}</span>
      ) : (
        <span className="capitalize">{state}</span>
      )}
    </span>
  );
}

function CapStepper({ server }: { server: ComputeServer }) {
  const update = useUpdateServer();
  const cap = server.maxConcurrent;

  function set(next: number) {
    const clamped = Math.min(MAX_CAP, Math.max(MIN_CAP, next));
    if (clamped === cap) return;
    update.mutate({ serverId: server.serverId, input: { maxConcurrent: clamped } });
  }

  return (
    <div className="flex items-center gap-1.5">
      <span className="text-xs text-muted-foreground">Cap</span>
      <Button
        variant="outline"
        size="icon-xs"
        disabled={cap <= MIN_CAP || update.isPending}
        onClick={() => set(cap - 1)}
        aria-label="Decrease cap"
      >
        −
      </Button>
      <span className="w-5 text-center font-mono text-xs tabular-nums">{cap}</span>
      <Button
        variant="outline"
        size="icon-xs"
        disabled={cap >= MAX_CAP || update.isPending}
        onClick={() => set(cap + 1)}
        aria-label="Increase cap"
      >
        +
      </Button>
    </div>
  );
}

function CopyInstallCommand({ command }: { command: string }) {
  const [copied, setCopied] = useState(false);
  function copy() {
    if (typeof navigator === 'undefined' || !navigator.clipboard) return;
    navigator.clipboard.writeText(command).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  }
  return (
    <div className="space-y-1.5 rounded-md border border-border bg-muted/30 p-2">
      <div className="break-all font-mono text-[10px] text-muted-foreground">{command}</div>
      <Button variant="outline" size="xs" onClick={copy}>
        {copied ? 'Copied!' : 'Copy install command'}
      </Button>
    </div>
  );
}

/** Local-machine cards have no provider VM to stop/start/destroy — they show
 * the (one-time-reveal) install command instead of the provider actions
 * menu. A fresh command is only available right after create or, for an
 * ERROR row, after Retry re-mints the enrollment token — this component
 * holds that transient value locally since the server row itself never
 * persists the plaintext token. */
function LocalMachineActions({ server }: { server: ComputeServer }) {
  const action = useServerAction();
  const [installCommand, setInstallCommand] = useState<string | undefined>(undefined);

  async function regenerate() {
    const result = await action.mutateAsync({ serverId: server.serverId, action: 'retry' });
    if (result.installCommand) setInstallCommand(result.installCommand);
  }

  if (installCommand) return <CopyInstallCommand command={installCommand} />;

  if (server.status === 'ERROR') {
    return (
      <Button variant="outline" size="xs" onClick={regenerate} disabled={action.isPending}>
        {action.isPending ? 'Generating…' : 'Generate install command'}
      </Button>
    );
  }

  return (
    <p className="text-[11px] italic text-muted-foreground">
      Install command was shown once at setup.
    </p>
  );
}

function ProviderActions({ server }: { server: ComputeServer }) {
  const action = useServerAction();
  const [confirmDestroy, setConfirmDestroy] = useState(false);
  const showStopStart = server.provider === 'gcp';
  const showRetry = server.status === 'ERROR';

  function run(kind: 'destroy' | 'retry' | 'stop' | 'start') {
    action.mutate({ serverId: server.serverId, action: kind });
  }

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger
          render={
            <Button variant="outline" size="xs" disabled={action.isPending}>
              Actions ▾
            </Button>
          }
        />
        <DropdownMenuContent align="end">
          {showStopStart && server.status === 'ACTIVE' && (
            <DropdownMenuItem onClick={() => run('stop')}>Stop</DropdownMenuItem>
          )}
          {showStopStart && server.status === 'PAUSED' && (
            <DropdownMenuItem onClick={() => run('start')}>Start</DropdownMenuItem>
          )}
          {showRetry && <DropdownMenuItem onClick={() => run('retry')}>Retry</DropdownMenuItem>}
          <DropdownMenuItem onClick={() => setConfirmDestroy(true)} className="text-destructive">
            Destroy
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <AlertDialog open={confirmDestroy} onOpenChange={setConfirmDestroy}>
        <AlertDialogContent className="max-w-md">
          <AlertDialogTitle className="text-destructive">
            Destroy &quot;{server.name}&quot;?
          </AlertDialogTitle>
          <AlertDialogDescription>
            This deletes the VM at the provider (delete = billing stops), revokes its AWS keys and
            enrollment token. Jobs assigned to it will be re-dispatched.
          </AlertDialogDescription>
          <div className="mt-4 flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setConfirmDestroy(false)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              disabled={action.isPending}
              onClick={() => {
                run('destroy');
                setConfirmDestroy(false);
              }}
            >
              {action.isPending ? 'Destroying…' : 'Destroy'}
            </Button>
          </div>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

export function ServerCard({ server }: { server: ComputeServer }) {
  const update = useUpdateServer();
  const isLocal = server.serviceType === 'local-machine';

  return (
    <Card className="p-4">
      <div className="flex items-start justify-between gap-2">
        <div>
          <div className="flex items-center gap-2">
            <span className="text-xs uppercase tracking-wide text-muted-foreground">
              {PROVIDER_LABEL[server.provider]}
            </span>
            <h3 className="text-sm font-semibold">{server.name}</h3>
          </div>
          <p className="mt-0.5 text-xs text-muted-foreground">
            {server.region} · {server.size} · {server.arch}
          </p>
        </div>
        <StatusBadge status={server.status} />
      </div>

      {server.statusMessage && (
        <p className="mt-2 text-[11px] text-destructive">{server.statusMessage}</p>
      )}

      <div className="mt-3 flex items-center justify-between">
        <HeartbeatIndicator server={server} />
        <span className="font-mono text-xs tabular-nums text-muted-foreground">
          {server.activeCount ?? 0}/{server.maxConcurrent}
        </span>
      </div>

      <div className="mt-1 text-xs text-muted-foreground">${server.costPerHour.toFixed(2)}/hr</div>

      <div className="mt-3 flex items-center justify-between">
        <label className="flex items-center gap-2 text-xs">
          <Switch
            checked={server.enabled}
            onCheckedChange={(checked: boolean) =>
              update.mutate({ serverId: server.serverId, input: { enabled: checked } })
            }
            disabled={update.isPending}
          />
          Enabled
        </label>
        <CapStepper server={server} />
      </div>

      <div className="mt-3">
        {isLocal ? <LocalMachineActions server={server} /> : <ProviderActions server={server} />}
      </div>
    </Card>
  );
}
