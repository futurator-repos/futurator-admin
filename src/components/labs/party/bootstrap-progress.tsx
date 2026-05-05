'use client';
import { useBootstrapEvents } from '@/hooks/use-party-bootstrap';
import type { PartyEvent } from '@/types/party';

interface Props {
  jobId: string;
}

const STEPS = [
  'validate',
  'refresh-source',
  'bmad-install',
  'sync-agents',
  'rebuild-manifest',
  'compute-sha',
  'verify',
  'persist',
];

type StepStatus = 'pending' | 'running' | 'done' | 'failed';

function computeStepStatuses(events: PartyEvent[]): Record<string, StepStatus> {
  const state: Record<string, StepStatus> = Object.fromEntries(
    STEPS.map((s) => [s, 'pending'] as const),
  );
  for (const ev of events) {
    const step = (ev as { step?: string }).step;
    if (!step) continue;
    if (ev.eventType === 'party.bootstrap.step.started') state[step] = 'running';
    if (ev.eventType === 'party.bootstrap.step.completed') state[step] = 'done';
    if (ev.eventType === 'party.bootstrap.step.failed') state[step] = 'failed';
  }
  return state;
}

export function BootstrapProgress({ jobId }: Props) {
  const { events, terminal } = useBootstrapEvents(jobId);
  const statuses = computeStepStatuses(events);

  const outputLines = events
    .filter((e) => e.eventType === 'party.bootstrap.step.output')
    .map((e) => {
      const data = (e as { data?: string }).data || '';
      const stream = (e as { stream?: string }).stream || 'stdout';
      return { stream, data };
    });

  return (
    <div
      aria-live="polite"
      className="rounded-md border border-border bg-card p-3 space-y-2"
      data-testid="bootstrap-progress"
    >
      <div className="flex items-center justify-between">
        <h4 className="text-xs font-semibold">Bootstrap progress</h4>
        {terminal === 'completed' && <span className="text-[10px] text-green-400">Completed</span>}
        {terminal === 'failed' && <span className="text-[10px] text-red-400">Failed</span>}
      </div>
      <ul className="space-y-1">
        {STEPS.map((step) => {
          const status = statuses[step];
          const dot =
            status === 'done'
              ? 'bg-green-500'
              : status === 'running'
                ? 'bg-blue-500 animate-pulse'
                : status === 'failed'
                  ? 'bg-red-500'
                  : 'bg-muted';
          return (
            <li key={step} className="flex items-center gap-2 text-[11px]">
              <span className={`h-2 w-2 rounded-full ${dot}`} />
              <span className="font-mono">{step}</span>
              <span className="text-muted-foreground ml-auto uppercase text-[9px]">{status}</span>
            </li>
          );
        })}
      </ul>
      {outputLines.length > 0 && (
        <details className="text-[10px]">
          <summary className="cursor-pointer text-muted-foreground">
            Raw output ({outputLines.length} lines)
          </summary>
          <pre className="mt-1 max-h-40 overflow-auto bg-muted/40 p-2 rounded text-[10px] font-mono">
            {outputLines.map((o, i) => (
              <div key={i} className={o.stream === 'stderr' ? 'text-red-400' : ''}>
                {o.data}
              </div>
            ))}
          </pre>
        </details>
      )}
    </div>
  );
}
