'use client';
/**
 * Pipeline v1 — Story 1.9. Failed-step panel.
 *
 * Rendered when a step's job is NEEDS_ATTENTION (or FAILED). Surfaces the
 * agent's structured "last words" (escalationPayload), the trigger reason,
 * and the four operator actions: Salvage, Retry (with optional hint), Skip,
 * Abort. The Talk button is rendered disabled until Epic 3 (Story 3.8)
 * wires conversation creation.
 *
 * Action buttons are disabled when the server-side preconditions are not
 * met (no salvageable extractors → Salvage off; not skipTolerant → Skip
 * off). Successful actions invalidate plans + attention queries via the
 * useStepActions hooks.
 */

import { useState } from 'react';
import type { AgentJob, JobTriggeredBy, PipelineStep } from '@/types/agent-orchestrator';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Textarea } from '@/components/ui/textarea';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog';
import { useSalvageStep, useRetryStep, useSkipStep, useAbortStep } from '@/hooks/use-step-actions';
import { ConversationPanel } from '@/components/labs/conversations/conversation-panel';

interface FailedStepPanelProps {
  job: AgentJob;
  /** Optional pipeline step for skipTolerant / salvageable lookup. */
  step?: PipelineStep;
  /** Step ID — usually derived from where the panel is rendered. */
  stepId: string;
}

const TRIGGER_LABELS: Record<JobTriggeredBy, string> = {
  AGENT_ESCALATED: 'Agent escalated',
  AGENT_NEEDS_HUMAN: 'Agent needs human input',
  LOOP_DETECTED: 'Loop detected',
  PREFLIGHT_FAILED: 'Pre-flight check failed',
  POSTVALIDATE_FAILED: 'Post-step validation failed',
  COST_CEILING: 'Cost ceiling hit',
  TIME_CEILING: 'Time ceiling hit',
  QUOTA_EXHAUSTED: 'Anthropic quota exhausted',
  CAPACITY_TIMEOUT: 'Slot acquisition timed out',
  RETRY_EXHAUSTED: 'Retries exhausted',
  OPERATOR_ABORT: 'Aborted by operator',
};

function formatElapsed(createdAt: string, updatedAt: string): string {
  const ms = new Date(updatedAt).getTime() - new Date(createdAt).getTime();
  if (!Number.isFinite(ms) || ms < 0) return '';
  const totalSec = Math.round(ms / 1000);
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return m > 0 ? `${m}m ${s}s` : `${s}s`;
}

export function FailedStepPanel({ job, step, stepId }: FailedStepPanelProps) {
  const [hintOpen, setHintOpen] = useState(false);
  const [hint, setHint] = useState('');
  const [skipReason, setSkipReason] = useState('');
  const [abortReason, setAbortReason] = useState('');
  const [showFullLog, setShowFullLog] = useState(false);
  const [talkOpen, setTalkOpen] = useState(false);

  const salvage = useSalvageStep();
  const retry = useRetryStep();
  const skip = useSkipStep();
  const abort = useAbortStep();

  const isAttention = job.status === 'NEEDS_ATTENTION';
  const isFailed = job.status === 'FAILED';
  const trigger = job.triggeredBy ? TRIGGER_LABELS[job.triggeredBy] : null;
  const elapsed = formatElapsed(job.createdAt, job.updatedAt);
  const cost = typeof job.totalCost === 'number' ? job.totalCost : 0;

  const canSalvage =
    isAttention &&
    !!job.salvageableExtractors &&
    job.salvageableExtractors.length > 0 &&
    step?.salvageable !== false;
  const canSkip = isAttention && step?.skipTolerant === true;
  const canRetry = isAttention;
  const canAbort = isAttention || job.status === 'RUNNING';

  const ep = job.escalationPayload;

  return (
    <div className="rounded-lg border bg-card p-4 space-y-3">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <Badge
            variant={isAttention ? 'outline' : 'destructive'}
            className={
              isAttention
                ? 'border-warning text-warning'
                : 'bg-destructive text-destructive-foreground'
            }
          >
            {isAttention ? 'NEEDS ATTENTION' : isFailed ? 'FAILED' : job.status}
          </Badge>
          {trigger && <span className="text-sm text-muted-foreground">{trigger}</span>}
        </div>
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          {cost > 0 && <span>cost so far: ${cost.toFixed(4)}</span>}
          {elapsed && <span>· time elapsed: {elapsed}</span>}
        </div>
      </div>

      {(ep?.whatFailed || ep?.whyStuck || ep?.whatTried?.length) && (
        <div className="space-y-2 text-sm">
          {ep.whatFailed && (
            <p>
              <span className="font-medium">What failed:</span> {ep.whatFailed}
            </p>
          )}
          {ep.whatTried?.length ? (
            <div>
              <p className="font-medium">What I tried:</p>
              <ul className="list-disc pl-5 text-muted-foreground">
                {ep.whatTried.map((t, i) => (
                  <li key={i}>{t}</li>
                ))}
              </ul>
            </div>
          ) : null}
          {ep.whyStuck && (
            <p>
              <span className="font-medium">Why stuck:</span> {ep.whyStuck}
            </p>
          )}
          {ep.humanQuestion && (
            <p className="rounded border-l-2 border-primary bg-muted/30 px-2 py-1">
              <span className="font-medium">Question:</span> {ep.humanQuestion}
            </p>
          )}
          {ep.recommendedAction && (
            <p className="text-xs text-muted-foreground">
              Agent suggests: <span className="font-mono">{ep.recommendedAction}</span>
            </p>
          )}
        </div>
      )}

      {!ep && job.errorMessage && (
        <pre className="text-xs text-muted-foreground whitespace-pre-wrap">
          {job.errorMessage.slice(0, 200)}
        </pre>
      )}

      <div className="flex flex-wrap gap-2">
        <Button
          size="sm"
          variant={canSalvage ? 'default' : 'outline'}
          disabled={!canSalvage || salvage.isPending}
          title={
            !canSalvage
              ? 'No extractors fired before failure — nothing to salvage.'
              : 'Apply already-extracted output as if the step had succeeded.'
          }
          onClick={() => salvage.mutate({ jobId: job.jobId, stepId })}
        >
          Salvage
        </Button>

        <Button
          size="sm"
          variant="outline"
          disabled={!canRetry || retry.isPending}
          onClick={() => setHintOpen((v) => !v)}
        >
          Retry
        </Button>

        <Button
          size="sm"
          variant="outline"
          disabled={!canSkip || skip.isPending}
          title={
            !canSkip
              ? "Step's output is required by downstream steps."
              : 'Mark this step manually skipped and advance the wave.'
          }
          onClick={() => skip.mutate({ jobId: job.jobId, stepId, reason: skipReason })}
        >
          Skip
        </Button>

        <Button size="sm" variant="outline" onClick={() => setTalkOpen(true)}>
          Talk
        </Button>

        <AlertDialog>
          <AlertDialogTrigger
            disabled={!canAbort || abort.isPending}
            className="inline-flex h-9 px-3 rounded-md text-sm bg-destructive text-destructive-foreground hover:bg-destructive/90 disabled:opacity-50 disabled:pointer-events-none"
          >
            Abort
          </AlertDialogTrigger>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Abort step?</AlertDialogTitle>
              <AlertDialogDescription>
                This marks the job FAILED and (if running) terminates the active Claude subprocess.
                The plan stops; you can salvage / restart a sibling later.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <Textarea
              placeholder="Optional reason"
              value={abortReason}
              onChange={(e) => setAbortReason(e.target.value)}
            />
            <AlertDialogFooter>
              <AlertDialogCancel>Cancel</AlertDialogCancel>
              <AlertDialogAction
                onClick={() => abort.mutate({ jobId: job.jobId, stepId, reason: abortReason })}
              >
                Abort job
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </div>

      {hintOpen && (
        <div className="space-y-2">
          <Textarea
            placeholder="Optional hint to prepend to the agent's first turn"
            value={hint}
            onChange={(e) => setHint(e.target.value)}
          />
          <div className="flex gap-2">
            <Button
              size="sm"
              onClick={() => {
                retry.mutate({ jobId: job.jobId, stepId, hint });
                setHintOpen(false);
                setHint('');
              }}
              disabled={retry.isPending}
            >
              Retry now
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setHintOpen(false)}>
              Cancel
            </Button>
          </div>
        </div>
      )}

      {canSkip && (
        <input
          className="text-xs w-full px-2 py-1 rounded border bg-background"
          placeholder="Skip reason (optional, recorded in audit)"
          value={skipReason}
          onChange={(e) => setSkipReason(e.target.value)}
        />
      )}

      <button
        className="text-xs text-muted-foreground underline"
        onClick={() => setShowFullLog((v) => !v)}
      >
        {showFullLog ? 'Hide full log' : 'Show full log'}
      </button>
      {showFullLog && (
        <pre className="text-xs max-h-64 overflow-auto rounded bg-muted p-2 whitespace-pre-wrap">
          {job.errorMessage || '(no error message recorded)'}
        </pre>
      )}

      {talkOpen && (
        <ConversationPanel jobId={job.jobId} stepId={stepId} onClose={() => setTalkOpen(false)} />
      )}
    </div>
  );
}
