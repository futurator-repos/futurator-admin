'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import type { App } from '@/types/app';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useDeleteApp } from '@/hooks/use-apps';
import { links } from '@/lib/links';

export function DeleteAppDialog({
  app,
  open,
  onOpenChange,
}: {
  app: App;
  open: boolean;
  onOpenChange: (next: boolean) => void;
}) {
  const router = useRouter();
  const remove = useDeleteApp(app.appId);
  const [confirmText, setConfirmText] = useState('');

  const canConfirm = confirmText === app.appId && !remove.isPending;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle className="text-destructive">Delete this App?</DialogTitle>
          <DialogDescription>
            This permanently deletes the App and ALL its Plans + Epics. The deployed
            bundle at <code>apps/{app.appId}/</code> is not removed by this action.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-2">
          <Label htmlFor="confirm-delete">
            Type <code className="rounded bg-muted px-1">{app.appId}</code> to confirm
          </Label>
          <Input
            id="confirm-delete"
            value={confirmText}
            onChange={(e) => setConfirmText(e.target.value)}
            autoComplete="off"
          />
          {remove.error && (
            <p className="text-sm text-destructive">{(remove.error as Error).message}</p>
          )}
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            variant="destructive"
            onClick={() =>
              remove.mutate(undefined, {
                onSuccess: () => {
                  onOpenChange(false);
                  router.push(links.apps());
                },
              })
            }
            disabled={!canConfirm}
          >
            {remove.isPending ? 'Deleting…' : 'Delete forever'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
