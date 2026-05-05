'use client';

import { useState } from 'react';
import type { App } from '@/types/app';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { useRedeployApp } from '@/hooks/use-apps';

interface DeployRow {
  jobId: string;
  createdAt?: string;
  planId?: string;
}

export function DeploysPanel({
  app,
  recentDeploys,
}: {
  app: App;
  recentDeploys: DeployRow[];
}) {
  const [confirmId, setConfirmId] = useState<string | null>(null);
  const redeploy = useRedeployApp(app.appId);

  if (recentDeploys.length === 0) {
    return (
      <div className="rounded-lg border bg-card p-6">
        <h2 className="mb-2 text-lg font-semibold">Deploys</h2>
        <p className="text-sm text-muted-foreground">No deploys yet.</p>
      </div>
    );
  }

  return (
    <>
      <div className="rounded-lg border bg-card p-6">
        <h2 className="mb-4 text-lg font-semibold">Deploys</h2>
        <ul className="space-y-2">
          {recentDeploys.map((d) => {
            const isLive = d.jobId === app.deployJobIds.at(-1);
            return (
              <li
                key={d.jobId}
                className="flex items-center justify-between gap-3 rounded-md border p-3 text-sm"
              >
                <div className="flex items-center gap-2">
                  {isLive ? (
                    <span className="text-success">●</span>
                  ) : (
                    <span className="text-muted-foreground">○</span>
                  )}
                  <span className="font-mono text-xs">{d.jobId}</span>
                  {isLive && (
                    <span className="rounded-full bg-success/15 px-2 py-0.5 text-xs text-success">
                      currently live
                    </span>
                  )}
                  {d.createdAt && (
                    <span className="text-xs text-muted-foreground">
                      {new Date(d.createdAt).toLocaleString()}
                    </span>
                  )}
                </div>
                {!isLive && (
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => setConfirmId(d.jobId)}
                  >
                    Re-deploy
                  </Button>
                )}
              </li>
            );
          })}
        </ul>
      </div>

      <Dialog open={!!confirmId} onOpenChange={() => setConfirmId(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Re-deploy this version?</DialogTitle>
            <DialogDescription>
              This rolls the live App back to an older bundle. You can move forward
              again by starting a new Plan.
            </DialogDescription>
          </DialogHeader>
          {redeploy.error && (
            <p className="text-sm text-destructive">{(redeploy.error as Error).message}</p>
          )}
          <DialogFooter>
            <Button variant="ghost" onClick={() => setConfirmId(null)}>
              Cancel
            </Button>
            <Button
              onClick={() => {
                if (!confirmId) return;
                redeploy.mutate(confirmId, {
                  onSuccess: () => setConfirmId(null),
                });
              }}
              disabled={redeploy.isPending}
            >
              {redeploy.isPending ? 'Re-deploying…' : 'Confirm re-deploy'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
