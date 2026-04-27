'use client';
/**
 * Pipeline v1 — Story 2.6. SessionPool concurrency chip.
 *
 * Compact widget for the admin header. Shows used/total slots at a glance
 * + queued count. Hover/click → popover with active sessions and queue
 * positions. Polls /api/health/concurrency every 30s when closed, every
 * 5s while the popover is open.
 */
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api-client';

interface ConcurrencySnapshot {
  ceiling: number;
  reservedInteractive?: number;
  slotsByClass: {
    interactive: { used: number; max: number };
    critical: { used: number };
    background: { used: number };
  };
  queueDepth: number;
  activeTokens: Array<{
    id: string;
    class: 'interactive' | 'critical' | 'background';
    jobId?: string;
    stepId?: string;
    planId?: string;
    acquiredAt: string;
  }>;
  queued: Array<{
    slotClass: 'interactive' | 'critical' | 'background';
    jobId?: string;
    queuedAt: string;
  }>;
}

export function ConcurrencyChip() {
  const [open, setOpen] = useState(false);
  const { data } = useQuery({
    queryKey: ['concurrency'],
    queryFn: () => api.get<ConcurrencySnapshot>('/health/concurrency'),
    refetchInterval: open ? 5_000 : 30_000,
    staleTime: 2_000,
  });

  if (!data) return null;
  const used =
    data.slotsByClass.interactive.used +
    data.slotsByClass.critical.used +
    data.slotsByClass.background.used;

  return (
    <div className="relative">
      <button
        onClick={() => setOpen((v) => !v)}
        className="inline-flex items-center gap-1 px-2 py-1 rounded-md border bg-background hover:bg-muted text-xs"
        title="SessionPool status"
      >
        <SlotDots used={used} ceiling={data.ceiling} />
        <span>
          {used}/{data.ceiling} in use
        </span>
        {data.queueDepth > 0 && (
          <span className="ml-1 text-warning">●{data.queueDepth} queued</span>
        )}
      </button>

      {open && (
        <div className="absolute right-0 mt-1 w-80 rounded-md border bg-popover shadow-lg p-3 space-y-3 text-xs z-50">
          <div className="grid grid-cols-3 gap-2">
            <Cell label="interactive" used={data.slotsByClass.interactive.used} />
            <Cell label="critical" used={data.slotsByClass.critical.used} />
            <Cell label="background" used={data.slotsByClass.background.used} />
          </div>

          <div className="space-y-1">
            <div className="font-medium text-muted-foreground">Active</div>
            {data.activeTokens.length === 0 ? (
              <div className="text-muted-foreground italic">none</div>
            ) : (
              data.activeTokens.map((t) => (
                <div key={t.id} className="flex justify-between">
                  <span>
                    <span className="text-muted-foreground">[{t.class}]</span>{' '}
                    {t.jobId?.slice(0, 8) || 'unknown'}
                  </span>
                  <span className="text-muted-foreground">
                    {new Date(t.acquiredAt).toLocaleTimeString()}
                  </span>
                </div>
              ))
            )}
          </div>

          {data.queued.length > 0 && (
            <div className="space-y-1">
              <div className="font-medium text-muted-foreground">Queued</div>
              {data.queued.map((q, i) => (
                <div key={`${q.jobId}-${i}`} className="flex justify-between">
                  <span>
                    <span className="text-muted-foreground">[{q.slotClass}]</span>{' '}
                    {q.jobId?.slice(0, 8) || 'unknown'}
                  </span>
                  {q.slotClass === 'background' && q.jobId && (
                    <button
                      className="underline text-primary"
                      onClick={() =>
                        api
                          .post(`/jobs/${q.jobId}/promote-class`, { to: 'critical' })
                          .catch(() => undefined)
                      }
                    >
                      promote
                    </button>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function Cell({ label, used }: { label: string; used: number }) {
  return (
    <div className="rounded border p-2 text-center">
      <div className="text-base font-semibold">{used}</div>
      <div className="text-[10px] text-muted-foreground">{label}</div>
    </div>
  );
}

function SlotDots({ used, ceiling }: { used: number; ceiling: number }) {
  const dots = [];
  for (let i = 0; i < ceiling; i++) {
    dots.push(
      <span
        key={i}
        className={`inline-block w-2 h-2 rounded-full ${i < used ? 'bg-primary' : 'bg-muted'}`}
      />,
    );
  }
  return <span className="inline-flex items-center gap-0.5">{dots}</span>;
}
