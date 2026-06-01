'use client';
import { useState } from 'react';
import { AlertDialog, AlertDialogContent, AlertDialogTitle } from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useDeletePlan } from '@/hooks/use-plans';
import type { PlanSummary } from '@/types/plan';
import { useQueryClient } from '@tanstack/react-query';

export function DeletePlanModal({
  plan,
  open,
  onOpenChange,
  onDeleted,
}: {
  plan: PlanSummary | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onDeleted?: () => void;
}) {
  const [typedName, setTypedName] = useState('');
  const qc = useQueryClient();
  const del = useDeletePlan(plan?.planId ?? null);

  if (!plan) return null;
  const canDelete = typedName === plan.name && !del.isPending;
  // PR-10 #2 — App/Plan v1 plans share the App's workingDir; deleting the
  // plan must NOT delete that folder. The label changes accordingly so
  // operator knows what's about to be removed.
  const isV1 = !!(plan as PlanSummary & { appId?: string }).appId;

  async function onConfirm() {
    if (!plan || !canDelete) return;
    await del.mutateAsync();
    setTypedName('');
    qc.invalidateQueries({ queryKey: ['plans'] });
    qc.invalidateQueries({ queryKey: ['apps'] });
    qc.invalidateQueries({ queryKey: ['app'] });
    onOpenChange(false);
    if (onDeleted) onDeleted();
  }

  return (
    <AlertDialog open={open} onOpenChange={(o) => (!o && setTypedName(''), onOpenChange(o))}>
      <AlertDialogContent className="max-w-md">
        <AlertDialogTitle className="text-destructive">
          Permanently delete `{plan.name}`?
        </AlertDialogTitle>
        <div className="space-y-3 text-sm">
          <div>This will delete:</div>
          <ul className="ml-4 list-disc space-y-1 text-xs text-muted-foreground">
            <li>All epics, stories, agent jobs, and events for this plan</li>
            <li>All attention items raised by this plan</li>
            {isV1 ? (
              <>
                <li>
                  The plan branch <code>plan/{plan.name}</code> on the App&apos;s GitHub repo and
                  locally on EC2 (post-fix plans only — legacy plans that committed straight to{' '}
                  <code>main</code> leave commits you&apos;ll need to revert manually on GitHub)
                </li>
                <li>
                  <strong>NOT</strong> the App&apos;s working tree —{' '}
                  <code>/home/ubuntu/projects/</code> stays put because other plans on the App share
                  it
                </li>
              </>
            ) : (
              <li>
                The EC2 folder at <code>/home/ubuntu/projects/{plan.name}</code>
              </li>
            )}
            <li>Any deployed app artifacts in S3 (if published)</li>
          </ul>
          <div className="rounded-md bg-muted/30 p-3 text-xs">
            <div>
              Total agent cost: <strong>${plan.totalCostUsd.toFixed(2)}</strong>
            </div>
            <div>
              Stories: <strong>{plan.totalStories}</strong> total,{' '}
              <strong>{plan.doneStories}</strong> done
            </div>
          </div>
          <div className="space-y-1 pt-2">
            <label className="text-xs">
              Type <code className="font-mono">{plan.name}</code> to confirm:
            </label>
            <Input
              value={typedName}
              onChange={(e) => setTypedName(e.target.value)}
              placeholder={plan.name}
              autoFocus
            />
          </div>
        </div>
        <div className="mt-4 flex justify-end gap-2">
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button variant="destructive" disabled={!canDelete} onClick={onConfirm}>
            {del.isPending ? 'Deleting…' : 'Delete forever'}
          </Button>
        </div>
      </AlertDialogContent>
    </AlertDialog>
  );
}
