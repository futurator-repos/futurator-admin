'use client';
import { useMemo, useState } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { AgentPhaseBlock } from './agent-phase-block';
import { DebugPanel } from './debug-panel';
import { CopyLogButton } from '@/components/labs/plan-dashboard/shared/copy-log-button';
import type { AgentEvent, AgentJob, AgentJobStatus } from '@/types/agent-orchestrator';

interface LiveOutputPanelProps {
  events: AgentEvent[];
  job?: AgentJob;
  isPolling: boolean;
}

interface StepGroup {
  stepId: string;
  agentId: string;
  events: AgentEvent[];
}

function groupByStep(events: AgentEvent[]): StepGroup[] {
  const groups: StepGroup[] = [];
  let current: StepGroup | null = null;

  for (const event of events) {
    if (!current || current.stepId !== event.stepId) {
      current = { stepId: event.stepId, agentId: event.agentId, events: [] };
      groups.push(current);
    }
    current.events.push(event);
  }

  return groups;
}

const STATUS_LABELS: Record<AgentJobStatus, string> = {
  PENDING: 'Waiting for daemon to pick up job...',
  RUNNING: 'Pipeline running',
  COMPLETED: 'Pipeline complete',
  FAILED: 'Pipeline failed',
};

export function LiveOutputPanel({ events, job, isPolling }: LiveOutputPanelProps) {
  const [showDebug, setShowDebug] = useState(true);
  const stepGroups = useMemo(() => groupByStep(events), [events]);

  // Show warning if job is PENDING and no events have arrived yet
  const pendingTooLong = job?.status === 'PENDING' && events.length === 0;

  return (
    <div className="space-y-4">
      {/* Debug panel */}
      <Card>
        <CardHeader className="pb-2">
          <div className="flex items-center justify-between">
            <CardTitle className="text-sm cursor-pointer" onClick={() => setShowDebug(!showDebug)}>
              Debug Panel {showDebug ? '\u25BC' : '\u25B6'}
              {isPolling && (
                <span className="ml-2 inline-block h-2 w-2 animate-pulse rounded-full bg-green-500" />
              )}
            </CardTitle>
            <div className="flex items-center gap-3 text-xs text-muted-foreground">
              {job?.status && <span>{STATUS_LABELS[job.status]}</span>}
              {job?.totalCost != null && job.totalCost > 0 && (
                <span>${job.totalCost.toFixed(4)}</span>
              )}
              {job?.currentStepIndex != null && job.pipeline && (
                <span>
                  Step {job.currentStepIndex + 1}/{job.pipeline.steps.length}
                </span>
              )}
            </div>
          </div>
        </CardHeader>
        {showDebug && (
          <CardContent>
            <DebugPanel events={events} job={job} />
          </CardContent>
        )}
      </Card>

      {/* Pending warning */}
      {pendingTooLong && (
        <div className="rounded-md border border-yellow-300 bg-yellow-50 p-3 text-sm text-yellow-800 dark:border-yellow-700 dark:bg-yellow-950 dark:text-yellow-300">
          Job has been PENDING for over 15s. Is the daemon running? Start it with:{' '}
          <code className="rounded bg-yellow-100 px-1 dark:bg-yellow-900">
            cd daemon && npm start
          </code>
        </div>
      )}

      {/* Step output panels */}
      <Card>
        <CardHeader className="pb-2">
          <div className="flex items-center justify-between gap-3">
            <CardTitle className="text-sm">Live Output</CardTitle>
            <CopyLogButton events={events} compact />
          </div>
        </CardHeader>
        <CardContent>
          {stepGroups.length === 0 && (
            <p className="py-8 text-center text-sm text-muted-foreground">
              {job?.status === 'PENDING' ? 'Waiting for daemon...' : 'No events yet.'}
            </p>
          )}
          <div className="space-y-4">
            {stepGroups.map((group, i) => (
              <AgentPhaseBlock
                key={`${group.stepId}-${i}`}
                group={group}
                pipeline={job?.pipeline}
              />
            ))}
          </div>
          {job?.status === 'FAILED' && job.errorMessage && (
            <div className="mt-4 rounded-md border border-red-300 bg-red-50 p-3 text-sm text-red-700 dark:border-red-800 dark:bg-red-950 dark:text-red-400">
              {job.errorMessage}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
