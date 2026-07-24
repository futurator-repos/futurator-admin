'use client';
import { Tooltip, TooltipTrigger, TooltipContent } from '@/components/ui/tooltip';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';

/**
 * Lane 2 (queue status lozenges) — a reusable, tooltip-bearing status badge
 * shared by the legend row and every request/row status cell in the Queues
 * module.
 *
 * Intentionally typed as `string`, not `QueueRequestStatus`: the dispatch/plan
 * side of the lifecycle (DEFERRED — the renamed C1/C2 "held" state — and any
 * future needs-human surfacing) is still landing on a parallel lane, and this
 * component must render whatever wire value shows up without a hard type
 * dependency on that in-flight enum. Unknown statuses fall back to a neutral
 * badge instead of throwing, so this never breaks on a status this lane
 * hasn't seen yet — app-agnostic, no content-specific keys.
 */
export interface StatusLozengeProps {
  status: string;
  className?: string;
}

interface StatusConfig {
  label: string;
  badgeClass: string;
  description: string;
}

/** Canonical config, keyed by normalized (upper-snake) status. */
const STATUS_CONFIG: Record<string, StatusConfig> = {
  RECEIVED: {
    label: 'Received',
    badgeClass: 'bg-slate-500/15 text-slate-400',
    description: 'The call was ingested and recorded — not yet picked up by a daemon.',
  },
  QUEUED: {
    label: 'Queued',
    badgeClass: 'bg-amber-500/15 text-amber-400',
    description: 'Admitted and waiting for a free execution slot on an eligible server.',
  },
  RUNNING: {
    label: 'Running',
    badgeClass: 'bg-blue-500/15 text-blue-400',
    description: 'A daemon has claimed this job and is actively executing it.',
  },
  COMPLETED: {
    label: 'Completed',
    badgeClass: 'bg-green-500/15 text-green-400',
    description: 'The job finished successfully; a response is ready to send (or was sent).',
  },
  FAILED: {
    label: 'Failed',
    badgeClass: 'bg-red-500/15 text-red-400',
    description: 'The job errored out before completing — see the error field for detail.',
  },
  RESPONDED: {
    label: 'Responded',
    badgeClass: 'bg-emerald-500/15 text-emerald-400',
    description: 'The completed result was delivered back to the caller or callback URL.',
  },
  DEFERRED: {
    label: 'Deferred',
    badgeClass: 'bg-violet-500/15 text-violet-400',
    description:
      'Admitted, but held behind an earlier plan for the same app — it starts once that plan reaches a terminal stage.',
  },
  NEEDS_ATTENTION: {
    label: 'Needs human',
    badgeClass: 'bg-orange-500/15 text-orange-400',
    description: 'The agent escalated for human input and is paused until someone responds.',
  },
};

/** Alternate wire spellings that resolve to a canonical config entry above. */
const STATUS_ALIASES: Record<string, string> = {
  HELD: 'DEFERRED',
  NEEDS_HUMAN: 'NEEDS_ATTENTION',
};

const FALLBACK_BADGE_CLASS = 'bg-muted text-muted-foreground';

function normalizeStatusKey(status: string): string {
  return status
    .trim()
    .toUpperCase()
    .replace(/[\s-]+/g, '_');
}

function toTitleCase(key: string): string {
  return key
    .toLowerCase()
    .split('_')
    .map((word) => (word ? word[0].toUpperCase() + word.slice(1) : word))
    .join(' ');
}

function resolveStatusConfig(status: string): StatusConfig {
  const key = normalizeStatusKey(status);
  const canonicalKey = STATUS_ALIASES[key] ?? key;
  const known = STATUS_CONFIG[canonicalKey];
  if (known) return known;
  return {
    label: toTitleCase(key),
    badgeClass: FALLBACK_BADGE_CLASS,
    description: `Unrecognized status "${status}".`,
  };
}

/** Statuses shown (in order) across the legend row. */
const LEGEND_ORDER = [
  'RECEIVED',
  'QUEUED',
  'RUNNING',
  'DEFERRED',
  'NEEDS_ATTENTION',
  'COMPLETED',
  'FAILED',
  'RESPONDED',
];

export function StatusLozenge({ status, className }: StatusLozengeProps) {
  const cfg = resolveStatusConfig(status);
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Badge variant="outline" className={cn('border-transparent', cfg.badgeClass, className)}>
            {cfg.label}
          </Badge>
        }
      />
      <TooltipContent>{cfg.description}</TooltipContent>
    </Tooltip>
  );
}

export function StatusLegend({ className }: { className?: string }) {
  return (
    <div
      className={cn(
        'flex flex-wrap items-center gap-1.5 rounded-md border border-border px-3 py-2',
        className,
      )}
    >
      <span className="mr-1 shrink-0 text-[10px] uppercase text-muted-foreground">
        Status legend
      </span>
      {LEGEND_ORDER.map((key) => (
        <StatusLozenge key={key} status={key} />
      ))}
    </div>
  );
}
