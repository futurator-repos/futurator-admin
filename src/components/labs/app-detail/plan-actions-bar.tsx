'use client';

import { useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import type { Plan } from '@/types/plan';
import { api } from '@/lib/api-client';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { useTransitionPlan } from '@/hooks/use-apps';

interface RunAsPipeline3Result {
  ok: boolean;
  stories?: number;
  errors?: string[];
}

export function PlanActionsBar({ plan }: { plan: Plan }) {
  const transition = useTransitionPlan(plan.planId);
  const [confirmAbandon, setConfirmAbandon] = useState(false);

  // Pipeline-3 test bridge — convert this legacy plan into a plan_spec + ingest
  // it as StoryNode rows, so it can run through the ready-frontier / story-dev
  // path (set P3_READY_FRONTIER=on on the daemon to dispatch them).
  const runAsP3 = useMutation<RunAsPipeline3Result>({
    mutationFn: () => api.post<RunAsPipeline3Result>(`/plans/${plan.planId}/run-as-pipeline-3`, {}),
  });

  const abandonButton = (
    <Button
      variant="ghost"
      className="ml-auto text-destructive hover:bg-destructive/10"
      onClick={() => setConfirmAbandon(true)}
    >
      Abandon
    </Button>
  );

  return (
    <>
      <div className="flex items-center gap-2 rounded-lg border bg-card p-3">
        {plan.status === 'concept' && (
          <>
            <Button onClick={() => transition.mutate('developing')} disabled={transition.isPending}>
              {transition.isPending ? 'Starting…' : 'Approve & Start Building'}
            </Button>
            <Button variant="ghost">Edit Proposal</Button>
            {abandonButton}
          </>
        )}
        {plan.status === 'developing' && (
          <>
            <span className="flex items-center gap-2 text-sm text-muted-foreground">
              <span className="size-2 animate-pulse rounded-full bg-accent-blue motion-reduce:animate-none" />
              Building…
            </span>
            {abandonButton}
          </>
        )}
        {plan.status === 'review' && (
          <>
            <Button onClick={() => transition.mutate('delivered')} disabled={transition.isPending}>
              Sign Off &amp; Deploy
            </Button>
            <Button
              variant="ghost"
              onClick={() => transition.mutate('developing')}
              disabled={transition.isPending}
            >
              Send back to dev
            </Button>
            {abandonButton}
          </>
        )}
        {plan.status === 'delivered' && (
          <span className="text-sm text-muted-foreground">
            Delivered — start a new Plan from the App page to iterate.
          </span>
        )}
        {plan.status === 'abandoned' && (
          <span className="text-sm text-muted-foreground">Abandoned.</span>
        )}

        {/* Pipeline-3 test bridge — available for plans that have epics to convert. */}
        {(plan.status === 'concept' ||
          plan.status === 'developing' ||
          plan.status === 'review') && (
          <Button
            variant="outline"
            size="sm"
            onClick={() => runAsP3.mutate()}
            disabled={runAsP3.isPending}
            title="Convert this plan to a plan_spec and ingest it as StoryNode rows (Pipeline-3)"
          >
            {runAsP3.isPending ? 'Converting…' : 'Run as Pipeline-3'}
          </Button>
        )}
        {runAsP3.isSuccess && runAsP3.data?.ok && (
          <span className="text-xs text-success">
            Ingested {runAsP3.data.stories ?? 0} stories → plan-spec-graph
          </span>
        )}
        {runAsP3.isSuccess && runAsP3.data && !runAsP3.data.ok && (
          <span className="text-xs text-destructive">
            Rejected: {(runAsP3.data.errors || []).slice(0, 2).join('; ')}
          </span>
        )}
        {runAsP3.isError && <span className="text-xs text-destructive">Failed to convert.</span>}
      </div>

      <Dialog open={confirmAbandon} onOpenChange={setConfirmAbandon}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Stop working on this Plan?</DialogTitle>
            <DialogDescription>
              You can start a new iteration after. The working tree will be marked as needing
              cleanup before another Plan begins.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setConfirmAbandon(false)}>
              Keep working
            </Button>
            <Button
              variant="destructive"
              onClick={() =>
                transition.mutate('abandoned', {
                  onSuccess: () => setConfirmAbandon(false),
                })
              }
              disabled={transition.isPending}
            >
              {transition.isPending ? 'Abandoning…' : 'Abandon Plan'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
