'use client';

import { Button } from '@/components/ui/button';
import { useUpdateApp } from '@/hooks/use-apps';
import { AlertTriangle } from 'lucide-react';

export function DirtyTreeBanner({
  appId,
  abandonedPlanLabel,
}: {
  appId: string;
  abandonedPlanLabel?: string;
}) {
  const update = useUpdateApp(appId);
  return (
    <div className="flex items-start gap-3 rounded-lg border border-warning/30 bg-warning/5 p-4">
      <AlertTriangle className="size-5 shrink-0 text-warning" aria-hidden />
      <div className="flex-1">
        <p className="text-sm">
          {abandonedPlanLabel ? <strong>{abandonedPlanLabel} didn&apos;t ship.</strong> : <strong>The previous Plan didn&apos;t ship.</strong>}{' '}
          Some files may still be in mid-edit state.{' '}
          <span className="text-muted-foreground">
            Click <strong>Mark resolved</strong> when you&apos;re ready to start the next iteration.
          </span>
        </p>
      </div>
      <Button
        size="sm"
        onClick={() => update.mutate({ workingTreeStatus: 'clean' })}
        disabled={update.isPending}
      >
        {update.isPending ? 'Marking…' : 'Mark resolved'}
      </Button>
    </div>
  );
}
