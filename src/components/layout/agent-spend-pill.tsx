'use client';
/**
 * AgentSpendPill — 2026-05-27 PR B.c.
 *
 * Header pill: shows today's (UTC) accumulated agent spend in dollars +
 * walltime in minutes. Read-only in PR B; PR C will gate new sessions
 * when spend exceeds the daily cap.
 *
 * Hidden until the daemon writes at least one spend row today (rowCount=0
 * → no pill). Keeps the header from showing "$0.00" before any agent has
 * run — that's an annoying empty-state.
 */

import { DollarSign } from 'lucide-react';
import { useTodaysAgentSpend } from '@/hooks/use-agent-spend';

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
  if (!data || data.rowCount === 0) return null;

  return (
    <div
      title={`Today (UTC): ${formatDollars(data.totalCostUsd)} across ${data.rowCount} job${data.rowCount === 1 ? '' : 's'}, ${formatWalltime(data.totalWalltimeSec)} of agent walltime.`}
      className="inline-flex h-7 items-center gap-1 rounded-md border border-border bg-card px-2 text-[12px] text-muted-foreground"
    >
      <DollarSign className="h-3 w-3" aria-hidden />
      <span className="font-mono font-medium text-foreground">
        {formatDollars(data.totalCostUsd)}
      </span>
      <span className="text-muted-foreground">
        {' · '}
        {formatWalltime(data.totalWalltimeSec)}
      </span>
    </div>
  );
}
