'use client';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Switch } from '@/components/ui/switch';
import { cn } from '@/lib/utils';
import {
  useDispatchPolicy,
  useSaveDispatchPolicy,
  useServers,
  useDispatchServerAware,
  useSetDispatchServerAware,
} from '@/hooks/use-servers';
import type { ComputeServer, DispatchMode } from '@/types/servers';
import { AssignmentsFeed } from './assignments-feed';

/** Server-aware dispatch on/off (spec §5's master gate). ON hands new jobs to
 * `runDispatchSweep()`'s policy engine, assigning them to fleet servers; OFF
 * reverts to legacy single-daemon behavior byte-for-byte. Turning it ON
 * re-sweeps immediately. */
function ServerAwareDispatchToggle() {
  const { data, isLoading } = useDispatchServerAware();
  const setServerAware = useSetDispatchServerAware();
  const serverAware = data?.serverAware ?? false;

  return (
    <Card className="space-y-1 p-4">
      <div className="flex items-center justify-between gap-4">
        <div>
          <h2 className="text-sm font-semibold">Server-aware dispatch</h2>
          <p className="text-xs text-muted-foreground">
            {serverAware
              ? 'ON — jobs are assigned to fleet servers by the policy below.'
              : 'OFF — legacy single-daemon behavior; the policy below has no effect.'}
          </p>
        </div>
        <Switch
          checked={serverAware}
          onCheckedChange={(checked: boolean) => setServerAware.mutate(checked)}
          disabled={isLoading || setServerAware.isPending}
          aria-label="Server-aware dispatch"
        />
      </div>
      {setServerAware.isSuccess && (
        <span className="text-xs text-success">Saved{serverAware ? ' — re-swept.' : '.'}</span>
      )}
      {setServerAware.isError && (
        <span className="text-xs text-destructive">
          Failed to save: {(setServerAware.error as Error).message}
        </span>
      )}
    </Card>
  );
}

const MODE_COPY: Record<DispatchMode, { label: string; description: string }> = {
  priority: {
    label: 'Priority',
    description:
      'Fill servers in a fixed order — the first enabled server in the list takes every job until it is at cap, then the next.',
  },
  weighted: {
    label: 'Weighted split',
    description:
      'Spread jobs across enabled servers by percentage — a rough traffic split, not a hard per-job guarantee.',
  },
  cheapest: {
    label: 'Cheapest-first',
    description:
      'Always prefer the enabled server with the lowest cost/hr that still has capacity.',
  },
};

function moveItem<T>(arr: T[], from: number, to: number): T[] {
  if (to < 0 || to >= arr.length) return arr;
  const next = [...arr];
  const [item] = next.splice(from, 1);
  next.splice(to, 0, item);
  return next;
}

function ModeSelector({
  mode,
  onChange,
}: {
  mode: DispatchMode;
  onChange: (mode: DispatchMode) => void;
}) {
  return (
    <div role="radiogroup" aria-label="Dispatch mode" className="space-y-2">
      {(Object.keys(MODE_COPY) as DispatchMode[]).map((m) => (
        <label
          key={m}
          className={cn(
            'flex cursor-pointer items-start gap-2 rounded-md border p-2.5 text-sm transition-colors',
            mode === m ? 'border-primary bg-primary/5' : 'border-border hover:bg-muted/40',
          )}
        >
          <input
            type="radio"
            name="dispatch-mode"
            value={m}
            checked={mode === m}
            onChange={() => onChange(m)}
            className="mt-0.5"
          />
          <span>
            <span className="font-medium">{MODE_COPY[m].label}</span>
            <p className="text-xs text-muted-foreground">{MODE_COPY[m].description}</p>
          </span>
        </label>
      ))}
    </div>
  );
}

/** Priority mode: ordered list of enabled servers, reordered with ↑/↓ and
 * persisted as `priorityOrder`. Servers not yet in `priorityOrder` (newly
 * added) are appended at the end. */
function PriorityEditor({
  servers,
  priorityOrder,
  onChange,
}: {
  servers: ComputeServer[];
  priorityOrder: string[];
  onChange: (next: string[]) => void;
}) {
  if (servers.length === 0) {
    return <p className="text-sm text-muted-foreground">No enabled servers to order.</p>;
  }
  const known = priorityOrder.filter((id) => servers.some((s) => s.serverId === id));
  const rest = servers.filter((s) => !known.includes(s.serverId)).map((s) => s.serverId);
  const order = [...known, ...rest];

  return (
    <ol className="space-y-1.5">
      {order.map((id, i) => {
        const server = servers.find((s) => s.serverId === id);
        if (!server) return null;
        return (
          <li
            key={id}
            className="flex items-center justify-between gap-2 rounded-md border border-border px-3 py-1.5 text-sm"
          >
            <span className="flex items-center gap-2">
              <span className="font-mono text-xs text-muted-foreground">{i + 1}.</span>
              {server.name}
              <span className="text-xs text-muted-foreground">
                ${server.costPerHour.toFixed(2)}/hr
              </span>
            </span>
            <span className="flex gap-1">
              <Button
                variant="outline"
                size="icon-xs"
                disabled={i === 0}
                aria-label={`Move ${server.name} up`}
                onClick={() => onChange(moveItem(order, i, i - 1))}
              >
                ↑
              </Button>
              <Button
                variant="outline"
                size="icon-xs"
                disabled={i === order.length - 1}
                aria-label={`Move ${server.name} down`}
                onClick={() => onChange(moveItem(order, i, i + 1))}
              >
                ↓
              </Button>
            </span>
          </li>
        );
      })}
    </ol>
  );
}

/** Weighted mode: one 0–100 slider per enabled server. Σ is shown live; the
 * UI only warns when it isn't 100 (the dispatch engine normalizes), it never
 * blocks Save. */
function WeightedEditor({
  servers,
  weights,
  onChange,
}: {
  servers: ComputeServer[];
  weights: Record<string, number>;
  onChange: (next: Record<string, number>) => void;
}) {
  if (servers.length === 0) {
    return <p className="text-sm text-muted-foreground">No enabled servers to weight.</p>;
  }
  const total = servers.reduce((sum, s) => sum + (weights[s.serverId] ?? 0), 0);

  return (
    <div className="space-y-3">
      {servers.map((server) => {
        const value = weights[server.serverId] ?? 0;
        return (
          <div key={server.serverId} className="space-y-1">
            <div className="flex items-center justify-between text-sm">
              <span>{server.name}</span>
              <span className="font-mono text-xs tabular-nums">{value}%</span>
            </div>
            <input
              type="range"
              min={0}
              max={100}
              value={value}
              onChange={(e) => onChange({ ...weights, [server.serverId]: Number(e.target.value) })}
              className="w-full accent-primary"
              aria-label={`${server.name} weight`}
            />
          </div>
        );
      })}
      <p className={cn('text-xs', total === 100 ? 'text-muted-foreground' : 'text-warning')}>
        Total: {total}%
        {total !== 100 &&
          ' — the engine normalizes to 100%, but a total close to 100 keeps the split predictable.'}
      </p>
    </div>
  );
}

/** Cheapest mode has nothing to edit — this is a read-only preview of the
 * order the engine will actually pick, sorted by cost/hr. */
function CheapestPreview({ servers }: { servers: ComputeServer[] }) {
  if (servers.length === 0) {
    return <p className="text-sm text-muted-foreground">No enabled servers.</p>;
  }
  const sorted = [...servers].sort((a, b) => a.costPerHour - b.costPerHour);

  return (
    <ol className="space-y-1.5">
      {sorted.map((server, i) => (
        <li
          key={server.serverId}
          className="flex items-center justify-between rounded-md border border-border px-3 py-1.5 text-sm"
        >
          <span className="flex items-center gap-2">
            <span className="font-mono text-xs text-muted-foreground">{i + 1}.</span>
            {server.name}
          </span>
          <span className="font-mono text-xs tabular-nums text-muted-foreground">
            ${server.costPerHour.toFixed(2)}/hr
          </span>
        </li>
      ))}
    </ol>
  );
}

export function PolicyTab() {
  const { data, isLoading, error } = useDispatchPolicy();
  const { data: serversData } = useServers();
  const save = useSaveDispatchPolicy();

  const enabledServers = (serversData?.servers ?? []).filter(
    (s) => s.enabled && s.status !== 'DELETED',
  );

  const [mode, setMode] = useState<DispatchMode>('priority');
  const [priorityOrder, setPriorityOrder] = useState<string[]>([]);
  const [weights, setWeights] = useState<Record<string, number>>({});
  const [hydrated, setHydrated] = useState(false);

  // Seed local editable state from the server once, on first load, so the
  // operator's in-progress edits aren't clobbered by a later refetch (e.g.
  // the invalidation after Save). Adjusting state during render — rather
  // than in a useEffect — per React's "storing information from previous
  // renders" pattern: React re-renders immediately with the seeded values
  // instead of committing a stale frame first.
  if (data?.policy && !hydrated) {
    setHydrated(true);
    setMode(data.policy.mode);
    setPriorityOrder(data.policy.priorityOrder);
    setWeights(data.policy.weights);
  }

  if (isLoading) {
    return <p className="text-sm text-muted-foreground">Loading dispatch policy…</p>;
  }
  if (error) {
    return (
      <div className="rounded-lg border border-destructive/30 bg-destructive/5 p-4 text-sm text-destructive">
        Failed to load dispatch policy: {(error as Error).message}
      </div>
    );
  }

  function handleSave() {
    save.mutate({ mode, priorityOrder, weights });
  }

  return (
    <div className="space-y-6">
      <ServerAwareDispatchToggle />

      <Card className="space-y-4 p-4">
        <div>
          <h2 className="text-sm font-semibold">Mode</h2>
          <p className="text-xs text-muted-foreground">
            How the dispatcher picks a server for each new job.
          </p>
        </div>

        <ModeSelector mode={mode} onChange={setMode} />

        <div>
          {mode === 'priority' && (
            <PriorityEditor
              servers={enabledServers}
              priorityOrder={priorityOrder}
              onChange={setPriorityOrder}
            />
          )}
          {mode === 'weighted' && (
            <WeightedEditor servers={enabledServers} weights={weights} onChange={setWeights} />
          )}
          {mode === 'cheapest' && <CheapestPreview servers={enabledServers} />}
        </div>

        <div className="flex items-center gap-2">
          <Button size="sm" onClick={handleSave} disabled={save.isPending}>
            {save.isPending ? 'Saving…' : 'Save policy'}
          </Button>
          {save.isSuccess && <span className="text-xs text-success">Saved — re-swept.</span>}
          {save.isError && (
            <span className="text-xs text-destructive">
              Failed to save: {(save.error as Error).message}
            </span>
          )}
        </div>
      </Card>

      <div>
        <h2 className="text-sm font-semibold">Recent assignments</h2>
        <p className="mb-2 text-xs text-muted-foreground">
          Verify the policy is behaving as expected — each row shows the dispatcher&apos;s
          reasoning.
        </p>
        <AssignmentsFeed />
      </div>
    </div>
  );
}
