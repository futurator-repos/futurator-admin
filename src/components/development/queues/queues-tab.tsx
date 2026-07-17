'use client';
import { useState } from 'react';
import { useQueueRequests } from '@/hooks/use-queue-requests';
import { useEc2Status } from '@/hooks/use-ec2-daemon';
import type { QueueRequest } from '@/types/queue';
import { QueueDetail, StatusBadge } from './queue-detail';

function CapStrip() {
  const { data: status } = useEc2Status(true);
  const active = status?.activeCount ?? 0;
  const max = status?.maxConcurrent ?? 0;
  const saturated = max > 0 && active >= max;
  return (
    <div className="flex items-center gap-3 rounded-md border border-border px-3 py-2">
      <span className="text-[10px] uppercase text-muted-foreground">Shared slots</span>
      <div className="h-2 w-32 rounded-full bg-muted overflow-hidden">
        <div
          className={`h-full transition-all ${saturated ? 'bg-red-500' : 'bg-green-500'}`}
          style={{ width: `${max > 0 ? (active / Math.max(max, 1)) * 100 : 0}%` }}
        />
      </div>
      <span className="font-mono text-xs tabular-nums">
        {active} / {max}
      </span>
      {saturated && <span className="text-[10px] text-amber-400">at cap — new calls queue</span>}
      <span className="ml-auto text-[10px] text-muted-foreground">
        daemon: {status?.daemonSource ?? '—'} · {status?.daemonAlive ? 'alive' : 'offline'}
      </span>
    </div>
  );
}

function relTime(iso?: string): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleTimeString();
}

export function QueuesTab() {
  const { data } = useQueueRequests();
  const [selected, setSelected] = useState<string | null>(null);
  const requests: QueueRequest[] = data?.requests ?? [];

  return (
    <div className="space-y-3">
      <CapStrip />

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {/* Request list */}
        <div className="rounded-md border border-border overflow-hidden">
          <table className="w-full text-xs">
            <thead className="bg-muted/40 text-muted-foreground">
              <tr>
                <th className="px-2 py-1.5 text-left font-medium">Status</th>
                <th className="px-2 py-1.5 text-left font-medium">Source</th>
                <th className="px-2 py-1.5 text-left font-medium">Target</th>
                <th className="px-2 py-1.5 text-left font-medium">Machine</th>
                <th className="px-2 py-1.5 text-left font-medium">Created</th>
              </tr>
            </thead>
            <tbody>
              {requests.length === 0 ? (
                <tr>
                  <td colSpan={5} className="px-2 py-6 text-center text-muted-foreground italic">
                    No requests yet. Fire one from the Tests tab or POST to /api/queue/ingest.
                  </td>
                </tr>
              ) : (
                requests.map((r) => (
                  <tr
                    key={r.requestId}
                    onClick={() => setSelected(r.requestId)}
                    className={`cursor-pointer border-t border-border hover:bg-accent/50 ${
                      selected === r.requestId ? 'bg-accent' : ''
                    }`}
                  >
                    <td className="px-2 py-1.5">
                      <StatusBadge status={r.status} />
                    </td>
                    <td className="px-2 py-1.5">{r.source}</td>
                    <td className="px-2 py-1.5 uppercase text-[10px] text-muted-foreground">
                      {r.target}
                    </td>
                    <td className="px-2 py-1.5 font-mono text-[10px] text-muted-foreground">
                      {r.response?.dispatcher?.host ?? '—'}
                    </td>
                    <td className="px-2 py-1.5 font-mono text-[10px] text-muted-foreground">
                      {relTime(r.createdAt)}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>

        {/* Detail */}
        <div>
          {selected ? (
            <QueueDetail requestId={selected} />
          ) : (
            <div className="rounded-md border border-dashed border-border p-8 text-center text-xs text-muted-foreground">
              Select a request to inspect its call details and live terminal.
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
