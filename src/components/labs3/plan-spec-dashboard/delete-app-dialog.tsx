'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
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

/**
 * Labs3 "Remove app" — the SDD sibling of legacy DeleteAppDialog. Hits the
 * SAME `DELETE /api/apps/:appId` teardown (Labs3 apps are rows in the same
 * `futurator-apps` registry), so one nuclear cascade covers everything:
 * GitHub repo, every Plan + StoryNode + Agent Job/Event, EC2 worktrees +
 * bare repo + node_modules store, Memgraph nodes, the public deployed bundle
 * AND — new for P3 — the dev.futurator.ai/<appId>/ preview + each plan's
 * `_qa/<planId>/` QA screenshots. There is no undo.
 *
 * Two-stage type-to-confirm (slug → DESTROY), identical guard-rails to the
 * legacy dialog. On success it returns to the Labs3 launcher.
 */
export function DeleteLabs3AppDialog({
  appId,
  appLabel,
  open,
  onOpenChange,
}: {
  appId: string;
  appLabel?: string;
  open: boolean;
  onOpenChange: (next: boolean) => void;
}) {
  const router = useRouter();
  const remove = useDeleteApp(appId);
  const [slugTyped, setSlugTyped] = useState('');
  const [destroyTyped, setDestroyTyped] = useState('');

  const slugMatched = slugTyped === appId;
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
            Remove app <code className="font-mono text-sm">{appLabel ?? appId}</code>?
          </DialogTitle>
          <DialogDescription className="text-xs">
            This is irreversible. The cascade runs every step server-side and surfaces per-step
            results in the response.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3 text-sm">
          <div>This will:</div>
          <ul className="ml-4 list-disc space-y-1 text-xs text-muted-foreground">
            <li>Delete every Plan + Story node + Agent Job + Agent Event</li>
            <li>
              Drop every <code>plan/*</code> branch + EC2 worktree, bare repo, and node_modules
              store
            </li>
            <li>
              <strong>Delete the GitHub repo</strong>{' '}
              <code className="font-mono">futurator-repos/{appId}</code> (no undo)
            </li>
            <li>Wipe the Memgraph knowledge nodes scoped to this app</li>
            <li>
              Purge the deployed bundle <code>apps/{appId}/</code> + Mycelium mirror{' '}
              <code>knowledge-live/{appId}/</code>
            </li>
            <li>
              Take down the dev preview <code>dev.futurator.ai/{appId}/</code> and delete its QA
              before/after screenshots
            </li>
            <li>Schedule the brownfield PAT secret for deletion (30-day AWS recovery window)</li>
            <li>Delete the App row</li>
          </ul>

          <div className="space-y-1 pt-1">
            <Label htmlFor="labs3-confirm-slug" className="text-xs">
              Type <code className="font-mono text-foreground">{appId}</code> to confirm:
            </Label>
            <Input
              id="labs3-confirm-slug"
              value={slugTyped}
              onChange={(e) => setSlugTyped(e.target.value)}
              placeholder={appId}
              autoFocus
              autoComplete="off"
              spellCheck={false}
            />
          </div>

          <div className="space-y-1">
            <Label htmlFor="labs3-confirm-destroy" className="text-xs">
              Then type <code className="font-mono text-foreground">DESTROY</code>:
            </Label>
            <Input
              id="labs3-confirm-destroy"
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
                  router.push('/labs3/');
                },
              })
            }
            disabled={!canConfirm}
          >
            {remove.isPending ? 'Removing…' : 'Remove forever'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
