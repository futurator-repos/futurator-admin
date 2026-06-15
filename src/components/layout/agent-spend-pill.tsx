'use client';
/**
 * AgentSpendPill — 2026-05-27 PR B.c + PR C.d.
 *
 * Header pill: shows today's (UTC) accumulated agent spend in dollars +
 * walltime in minutes. PR C.d adds the cap state — pill turns red when
 * today's spend exceeds AGENT_DAILY_SPEND_CAP_USD; clicking opens a small
 * override modal that calls POST /api/admin/spend-cap/override-today.
 *
 * Hidden until the daemon writes at least one spend row today (rowCount=0
 * → no pill). Keeps the header from showing "$0.00" before any agent has
 * run — that's an annoying empty-state.
 */

import { useState } from 'react';
import { DollarSign, AlertTriangle, Loader2 } from 'lucide-react';
import { useTodaysAgentSpend } from '@/hooks/use-agent-spend';
import { useMutation } from '@tanstack/react-query';
import { useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api-client';

// Mirror of the daemon-side env. The Lambda is authoritative; the UI surfaces
// the same default. Operator can override via the API; this constant is just
// the threshold the pill uses for "spent enough to warn."
const UI_DAILY_CAP_USD_DEFAULT = 200;

function formatDollars(usd: number): string {
  if (usd >= 100) return `$${Math.round(usd)}`;
  if (usd >= 10) return `$${usd.toFixed(1)}`;
  return `$${usd.toFixed(2)}`;
}

function formatWalltime(sec: number): string {
  if (sec < 60) return `${Math.round(sec)}s`;
  const min = Math.round(sec / 60);
  if (min < 60) return `${min}m`;
  const hr = sec / 3600;
  return `${hr.toFixed(1)}h`;
}

export function AgentSpendPill() {
  const { data } = useTodaysAgentSpend();
  const [showOverride, setShowOverride] = useState(false);
  const qc = useQueryClient();

  const override = useMutation({
    mutationFn: () =>
      // base URL already ends in /api — no second /api prefix (else 404)
      api.post<{ overridden: true; date: string }>('/admin/spend-cap/override-today', {}),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['agent', 'spend', 'today'] });
      setShowOverride(false);
    },
  });

  if (!data || data.rowCount === 0) return null;

  const overCap = data.totalCostUsd >= UI_DAILY_CAP_USD_DEFAULT;
  const nearCap = !overCap && data.totalCostUsd >= UI_DAILY_CAP_USD_DEFAULT * 0.8;

  return (
    <>
      <button
        type="button"
        onClick={() => overCap && setShowOverride(true)}
        disabled={!overCap}
        title={
          overCap
            ? `Daily cap reached — new sessions blocked. Tap to grant a one-day override.`
            : `Today (UTC): ${formatDollars(data.totalCostUsd)} across ${data.rowCount} job${data.rowCount === 1 ? '' : 's'}, ${formatWalltime(data.totalWalltimeSec)} of agent walltime.`
        }
        className={[
          'inline-flex h-7 items-center gap-1 rounded-md border px-2 text-[12px]',
          overCap
            ? 'border-destructive/40 bg-destructive/15 text-destructive cursor-pointer hover:bg-destructive/25'
            : nearCap
              ? 'border-warning/40 bg-warning/10 text-warning cursor-default'
              : 'border-border bg-card text-muted-foreground cursor-default',
        ].join(' ')}
      >
        {overCap ? (
          <AlertTriangle className="h-3 w-3" aria-hidden />
        ) : (
          <DollarSign className="h-3 w-3" aria-hidden />
        )}
        <span
          className={overCap ? 'font-mono font-medium' : 'font-mono font-medium text-foreground'}
        >
          {formatDollars(data.totalCostUsd)}
        </span>
        <span className={overCap ? '' : 'text-muted-foreground'}>
          {' / '}
          {formatDollars(UI_DAILY_CAP_USD_DEFAULT)}
        </span>
      </button>
      {showOverride && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
          <div className="w-full max-w-md rounded-lg border border-destructive/40 bg-card p-4 shadow-xl">
            <div className="flex items-center gap-2">
              <AlertTriangle className="h-4 w-4 text-destructive" aria-hidden />
              <span className="text-[14px] font-medium text-foreground">
                Daily spend cap reached
              </span>
            </div>
            <p className="mt-2 text-[12px] text-muted-foreground">
              Today&apos;s spend ({formatDollars(data.totalCostUsd)}) exceeds the cap (
              {formatDollars(UI_DAILY_CAP_USD_DEFAULT)}). Grant a one-day override? The override
              auto-expires at the next UTC day boundary.
            </p>
            <div className="mt-3 flex items-center justify-end gap-2">
              <button
                type="button"
                onClick={() => setShowOverride(false)}
                disabled={override.isPending}
                className="rounded-md border border-border bg-card px-2 py-1 text-[12px] text-muted-foreground hover:text-foreground"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => override.mutate()}
                disabled={override.isPending}
                className="rounded-md border border-destructive/40 bg-destructive/15 px-2 py-1 text-[12px] font-medium text-destructive hover:bg-destructive/25 disabled:cursor-wait disabled:opacity-60"
              >
                {override.isPending ? (
                  <Loader2 className="inline h-3 w-3 animate-spin" />
                ) : (
                  'Grant override for today'
                )}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
