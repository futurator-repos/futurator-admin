'use client';
/**
 * AgentPauseToggle — 2026-05-27 PR B.f.
 *
 * Header pill: shows the global agent-pause state and lets the operator
 * toggle it. Visible across all admin routes (the daemon obeys this flag
 * before claiming any PENDING job, regardless of agent class).
 *
 * Per §7 binding rule, this control MUST exist before any auto-merge surface
 * (PR C). The pause is global — paused agents don't claim new sessions or
 * new turns; in-flight jobs complete normally on their own.
 */

import { Pause, Play, Loader2 } from 'lucide-react';
import { useIsAgentPaused, usePauseAgent, useResumeAgent } from '@/hooks/use-agent-flags';

export function AgentPauseToggle() {
  const paused = useIsAgentPaused();
  const pause = usePauseAgent();
  const resume = useResumeAgent();
  const isBusy = pause.isPending || resume.isPending;

  const onClick = () => {
    if (isBusy) return;
    if (paused) resume.mutate();
    else pause.mutate();
  };

  return (
    <button
      type="button"
      onClick={onClick}
      disabled={isBusy}
      title={
        paused
          ? 'Agent is paused. New sessions / turns are blocked. Click to resume.'
          : 'Pause the agent globally. In-flight jobs finish; new sessions / turns are blocked.'
      }
      className={[
        'inline-flex h-7 items-center gap-1.5 rounded-md border px-2 text-[12px] font-medium transition-colors',
        paused
          ? 'border-warning/40 bg-warning/15 text-warning hover:bg-warning/25'
          : 'border-border bg-card text-muted-foreground hover:text-foreground hover:bg-muted',
        isBusy && 'cursor-wait opacity-60',
      ]
        .filter(Boolean)
        .join(' ')}
    >
      {isBusy ? (
        <Loader2 className="h-3 w-3 animate-spin" aria-hidden />
      ) : paused ? (
        <Play className="h-3 w-3" aria-hidden />
      ) : (
        <Pause className="h-3 w-3" aria-hidden />
      )}
      <span>{paused ? 'Resume' : 'Pause'}</span>
    </button>
  );
}
