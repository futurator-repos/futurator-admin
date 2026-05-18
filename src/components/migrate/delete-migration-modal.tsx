'use client';
import { useState } from 'react';
import { AlertDialog, AlertDialogContent, AlertDialogTitle } from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useDeleteMigration } from '@/hooks/use-migrations';
import type { Migration } from '@/types/migration';
import { useQueryClient } from '@tanstack/react-query';

export function DeleteMigrationModal({
  migration,
  open,
  onOpenChange,
}: {
  migration: Migration | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [typed, setTyped] = useState('');
  const qc = useQueryClient();
  const del = useDeleteMigration();

  if (!migration) return null;
  const canDelete = typed === migration.projectId && !del.isPending;

  async function onConfirm() {
    if (!migration || !canDelete) return;
    await del.mutateAsync(migration.projectId);
    setTyped('');
    qc.invalidateQueries({ queryKey: ['migrations'] });
    qc.invalidateQueries({ queryKey: ['apps'] });
    qc.invalidateQueries({ queryKey: ['party', 'projects'] });
    onOpenChange(false);
  }

  return (
    <AlertDialog open={open} onOpenChange={(o) => (!o && setTyped(''), onOpenChange(o))}>
      <AlertDialogContent className="max-w-md" data-testid="delete-migration-modal">
        <AlertDialogTitle className="text-destructive">
          Delete migration <code className="font-mono text-sm">{migration.projectId}</code>?
        </AlertDialogTitle>
        <div className="space-y-3 text-sm">
          <div>This will:</div>
          <ul className="ml-4 list-disc space-y-1 text-xs text-muted-foreground">
            <li>Remove the brownfield project row from DynamoDB</li>
            <li>Remove the Apps registry row (hides it from /labs and /debates)</li>
            <li>
              Delete <strong>{migration.sessionCount}</strong> debate
              {migration.sessionCount === 1 ? '' : 's'} attached to this project
            </li>
            <li>
              Schedule the per-project PAT secret for deletion (
              <strong>30-day AWS recovery window</strong>)
            </li>
          </ul>
          <div className="rounded-md border border-warning/40 bg-warning/5 p-3 text-xs">
            The EC2 folder{' '}
            <code className="font-mono">/home/ubuntu/projects/{migration.projectId}</code> is{' '}
            <strong>NOT</strong> deleted. To wipe it, SSH in and{' '}
            <code className="font-mono">rm&nbsp;-rf</code> manually.
          </div>
          <div className="space-y-1 pt-2">
            <label className="text-xs" htmlFor="confirm-migration-name">
              Type <code className="font-mono text-foreground">{migration.projectId}</code> to
              confirm:
            </label>
            <Input
              id="confirm-migration-name"
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
              placeholder={migration.projectId}
              autoFocus
              autoComplete="off"
              spellCheck={false}
              data-testid="delete-migration-input"
            />
          </div>
        </div>
        <div className="mt-4 flex justify-end gap-2">
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={del.isPending}>
            Cancel
          </Button>
          <Button
            variant="destructive"
            disabled={!canDelete}
            onClick={onConfirm}
            data-testid="delete-migration-confirm"
          >
            {del.isPending ? 'Deleting…' : 'Delete forever'}
          </Button>
        </div>
      </AlertDialogContent>
    </AlertDialog>
  );
}
