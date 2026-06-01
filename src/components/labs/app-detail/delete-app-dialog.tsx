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

/**
 * Two-stage type-to-confirm. Step 1: type the App slug to enable
 * "Continue". Step 2: type the literal word DESTROY to enable the
 * destructive button. The two-stage form exists because App-delete now
 * cascades to: GitHub repo deletion, S3 deployed-artifact purge,
 * knowledge-live mirror purge, brownfield PAT secret schedule-delete, and
 * EC2 folder rm. There is no undo — the GitHub repo is gone, the Secrets
 * Manager record enters a 30-day recovery window, and S3 deletes are
 * permanent.
 */
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
  const [slugTyped, setSlugTyped] = useState('');
  const [destroyTyped, setDestroyTyped] = useState('');

  const slugMatched = slugTyped === app.appId;
  const destroyMatched = destroyTyped === 'DESTROY';
  const canConfirm = slugMatched && destroyMatched && !remove.isPending;

  function reset() {
    setSlugTyped('');
    setDestroyTyped('');
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (!o) reset();
        onOpenChange(o);
      }}
    >
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="text-destructive">
            Destroy App <code className="font-mono text-sm">{app.appId}</code>?
          </DialogTitle>
          <DialogDescription className="text-xs">
            This is irreversible. The cascade runs every step server-side and surfaces per-step
            results in the response.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3 text-sm">
          <div>This will:</div>
          <ul className="ml-4 list-disc space-y-1 text-xs text-muted-foreground">
            <li>Delete every Plan + Epic + Story + Agent Job + Agent Event</li>
            <li>
              Drop every <code>plan/*</code> branch on the App&apos;s GitHub repo and local EC2
              worktree
            </li>
            <li>
              <strong>Delete the GitHub repo</strong>{' '}
              <code className="font-mono">futurator-repos/{app.appId}</code> (no undo)
            </li>
            <li>
              <code>rm -rf /home/ubuntu/projects/{app.appId}</code> on EC2
            </li>
            <li>
              Purge <code>s3://futurator-ai-website/apps/{app.appId}/</code> (deployed bundle)
            </li>
            <li>
              Purge <code>s3://futurator-ai-website/knowledge-live/{app.appId}/</code> (Mycelium
              mirror)
            </li>
            <li>
              Schedule the brownfield PAT secret for deletion (30-day AWS recovery window —
              re-create the App within 30 days to restore)
            </li>
            <li>Delete the App row</li>
          </ul>

          <div className="space-y-1 pt-1">
            <Label htmlFor="confirm-slug" className="text-xs">
              Type <code className="font-mono text-foreground">{app.appId}</code> to confirm:
            </Label>
            <Input
              id="confirm-slug"
              value={slugTyped}
              onChange={(e) => setSlugTyped(e.target.value)}
              placeholder={app.appId}
              autoFocus
              autoComplete="off"
              spellCheck={false}
            />
          </div>

          <div className="space-y-1">
            <Label htmlFor="confirm-destroy" className="text-xs">
              Then type <code className="font-mono text-foreground">DESTROY</code>:
            </Label>
            <Input
              id="confirm-destroy"
              value={destroyTyped}
              onChange={(e) => setDestroyTyped(e.target.value)}
              placeholder="DESTROY"
              autoComplete="off"
              spellCheck={false}
              disabled={!slugMatched}
            />
          </div>

          {remove.error && (
            <p className="text-sm text-destructive">{(remove.error as Error).message}</p>
          )}
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={remove.isPending}>
            Cancel
          </Button>
          <Button
            variant="destructive"
            onClick={() =>
              remove.mutate(undefined, {
                onSuccess: () => {
                  reset();
                  onOpenChange(false);
                  router.push(links.apps());
                },
              })
            }
            disabled={!canConfirm}
          >
            {remove.isPending ? 'Destroying…' : 'Destroy forever'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
