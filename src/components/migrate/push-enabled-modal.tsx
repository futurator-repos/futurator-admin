'use client';
/**
 * Story 21.3 (party-push Epic 21) — Push enabled modal.
 *
 * Flipping a brownfield project's "Push" toggle ON requires:
 *  1. A fresh fine-grained PAT scoped `contents:write` on this repo only
 *  2. The operator's acknowledgement that GitHub branch protection on
 *     the canonical branch (main/master) is configured — otherwise the
 *     hook's `git push origin main` deny is the only line of defense
 *
 * Disabling (pushEnabled=false) is a one-click confirm — no PAT required.
 * The daemon's `party-checkpoint.sh` reads `project.pushEnabled` per
 * checkpoint, so this takes effect on the next round.
 */
import { useState } from 'react';
import { AlertTriangle, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';
import { Input } from '@/components/ui/input';
import { useUpdateMigration } from '@/hooks/use-migrations';
import type { Migration } from '@/types/migration';

const PAT_PATTERN = /^(github_pat_|ghp_|github_token_)/;

interface Props {
  migration: Migration | null;
  open: boolean;
  intent: 'enable' | 'disable';
  onOpenChange: (open: boolean) => void;
  onSuccess?: () => void;
}

export function PushEnabledModal({ migration, open, intent, onOpenChange, onSuccess }: Props) {
  const [pat, setPat] = useState('');
  const [ackBranchProtection, setAckBranchProtection] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const update = useUpdateMigration();

  if (!migration) return null;

  function reset() {
    setPat('');
    setAckBranchProtection(false);
    setError(null);
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (!migration) return;
    if (intent === 'enable') {
      if (!PAT_PATTERN.test(pat)) {
        setError('PAT must start with github_pat_ / ghp_ / github_token_');
        return;
      }
      if (!ackBranchProtection) {
        setError('Please confirm branch protection is configured on the canonical branch.');
        return;
      }
    }
    try {
      await update.mutateAsync({
        projectId: migration.projectId,
        pushEnabled: intent === 'enable',
        ...(intent === 'enable' ? { pat } : {}),
      });
      reset();
      onOpenChange(false);
      onSuccess?.();
    } catch (err) {
      setError((err as Error).message || 'failed to update push toggle');
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (!o) reset();
        onOpenChange(o);
      }}
    >
      <DialogContent className="sm:max-w-[520px]">
        <form onSubmit={handleSubmit}>
          <DialogHeader>
            <DialogTitle>
              {intent === 'enable' ? 'Enable push for ' : 'Disable push for '}
              <span className="font-mono">{migration.projectId}</span>
            </DialogTitle>
            <DialogDescription>
              {intent === 'enable' ? (
                <>
                  Allow the party-checkpoint daemon to push <code>party/&lt;sid&gt;</code> branches
                  on this project to GitHub. Requires a fresh fine-grained PAT scoped{' '}
                  <code>contents:write</code> on this single repo.
                </>
              ) : (
                <>
                  Stop the daemon from pushing party branches. Existing local commits stay; future
                  rounds commit locally only.
                </>
              )}
            </DialogDescription>
          </DialogHeader>

          {intent === 'enable' && (
            <div className="space-y-4 py-4">
              <div className="rounded-md border border-amber-500/30 bg-amber-500/5 p-3 text-[12px] text-amber-200">
                <div className="flex gap-2">
                  <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
                  <div className="space-y-2">
                    <div className="font-semibold">Branch protection prerequisite</div>
                    <div>
                      Configure GitHub branch protection on{' '}
                      <code>{migration.gitBranch || 'main'}</code> before enabling. The hook denies{' '}
                      <code>git push origin main</code> client-side, but server-side protection is
                      the load-bearing safeguard against a hook bypass.
                    </div>
                  </div>
                </div>
              </div>

              <div className="space-y-2">
                <Label htmlFor="push-pat" className="text-[12px]">
                  contents:write PAT
                </Label>
                <Input
                  id="push-pat"
                  type="password"
                  autoComplete="off"
                  placeholder="github_pat_…"
                  value={pat}
                  onChange={(e) => setPat(e.target.value)}
                  className="font-mono text-[12px]"
                  data-testid="push-pat-input"
                />
                <div className="text-[11px] text-muted-foreground">
                  Fine-grained PAT, scoped <code>contents:write</code> on{' '}
                  <code>
                    {migration.gitRepoUrl
                      ?.replace(/^https:\/\/github\.com\//, '')
                      .replace(/\.git$/, '') || migration.projectId}
                  </code>{' '}
                  only. Stored in AWS Secrets Manager; never logged.
                </div>
              </div>

              <label className="flex cursor-pointer items-start gap-2 text-[12px]">
                <input
                  type="checkbox"
                  checked={ackBranchProtection}
                  onChange={(e) => setAckBranchProtection(e.target.checked)}
                  className="mt-0.5"
                  data-testid="push-ack-checkbox"
                />
                <span>
                  Branch protection is configured on <code>{migration.gitBranch || 'main'}</code>{' '}
                  (or I accept the risk for this repo).
                </span>
              </label>
            </div>
          )}

          {intent === 'disable' && (
            <div className="py-4 text-[12px] text-muted-foreground">
              Daemon will continue running party sessions; checkpoints will commit locally only. You
              can re-enable any time.
            </div>
          )}

          {error && (
            <div
              className="mb-2 rounded-md border border-destructive/30 bg-destructive/5 p-2 text-[12px] text-destructive"
              data-testid="push-modal-error"
            >
              {error}
            </div>
          )}

          <DialogFooter>
            <Button
              type="button"
              variant="ghost"
              onClick={() => {
                reset();
                onOpenChange(false);
              }}
              disabled={update.isPending}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={update.isPending} data-testid="push-modal-submit">
              {update.isPending && <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />}
              {intent === 'enable' ? 'Enable push' : 'Disable push'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
