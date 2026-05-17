'use client';

import { useState } from 'react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Button } from '@/components/ui/button';
import { usePartyStore } from '@/stores/party-store';
import { useCreateBrownfieldProjectMutation } from '@/hooks/use-party-projects';

// Mirrors functions/shared/types/party.ts (PROJECT_ID_REGEX) +
// GITHUB_HTTPS_URL_REGEX. Inline validation lets us disable Submit until the
// user has a plausible payload — the server still does authoritative zod
// validation via createPartyProjectInputSchema.
const NAME_REGEX = /^[a-z0-9][a-z0-9-]{0,63}$/;
const URL_REGEX = /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+(\.git)?$/;
const BRANCH_REGEX = /^\S+$/;

/**
 * Story 15.4 — modal form for registering a brownfield Party project from
 * an existing private GitHub repo. Three fields (name, gitRepoUrl,
 * gitBranch) with inline regex validation. On submit it calls
 * useCreateBrownfieldProjectMutation; on success it closes itself and the
 * projects list refetches.
 */
export function AddBrownfieldForm() {
  const isOpen = usePartyStore((s) => s.isBrownfieldFormOpen);
  const closeForm = usePartyStore((s) => s.closeBrownfieldForm);
  const create = useCreateBrownfieldProjectMutation();

  const [name, setName] = useState('');
  const [gitRepoUrl, setGitRepoUrl] = useState('');
  const [gitBranch, setGitBranch] = useState('main');
  const [submitError, setSubmitError] = useState<string | null>(null);

  const nameValid = NAME_REGEX.test(name);
  const urlValid = URL_REGEX.test(gitRepoUrl);
  const branchValid = BRANCH_REGEX.test(gitBranch);
  const canSubmit = nameValid && urlValid && branchValid && !create.isPending;

  function resetAndClose() {
    setName('');
    setGitRepoUrl('');
    setGitBranch('main');
    setSubmitError(null);
    closeForm();
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!canSubmit) return;
    setSubmitError(null);
    try {
      await create.mutateAsync({ name, gitRepoUrl, gitBranch });
      resetAndClose();
    } catch (err) {
      setSubmitError(err instanceof Error ? err.message : 'Failed to register project');
    }
  }

  return (
    <Dialog
      open={isOpen}
      onOpenChange={(next) => {
        if (!next) resetAndClose();
      }}
    >
      <DialogContent className="sm:max-w-[480px]" data-testid="add-brownfield-form">
        <DialogHeader>
          <DialogTitle>Add brownfield project</DialogTitle>
          <DialogDescription>
            Register an existing private GitHub repo as a Party project. The daemon clones it once;
            you push from your laptop and tap Refresh on the card to pull updates. EC2 mirrors
            GitHub.
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={handleSubmit} className="space-y-3 py-2">
          <div className="space-y-1">
            <Label htmlFor="brownfield-name">Project name (kebab-case)</Label>
            <Input
              id="brownfield-name"
              data-testid="brownfield-name"
              autoFocus
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="songster"
              className="font-mono text-sm"
              aria-invalid={name.length > 0 && !nameValid ? 'true' : undefined}
            />
            {name.length > 0 && !nameValid && (
              <p className="text-[11px] text-red-400">Must match ^[a-z0-9][a-z0-9-]{'{0,63}'}$</p>
            )}
          </div>

          <div className="space-y-1">
            <Label htmlFor="brownfield-url">GitHub HTTPS URL</Label>
            <Input
              id="brownfield-url"
              data-testid="brownfield-url"
              value={gitRepoUrl}
              onChange={(e) => setGitRepoUrl(e.target.value)}
              placeholder="https://github.com/owner/repo"
              className="font-mono text-sm"
              aria-invalid={gitRepoUrl.length > 0 && !urlValid ? 'true' : undefined}
            />
            {gitRepoUrl.length > 0 && !urlValid && (
              <p className="text-[11px] text-red-400">
                Must be an HTTPS GitHub URL (https://github.com/owner/repo)
              </p>
            )}
          </div>

          <div className="space-y-1">
            <Label htmlFor="brownfield-branch">Branch</Label>
            <Input
              id="brownfield-branch"
              data-testid="brownfield-branch"
              value={gitBranch}
              onChange={(e) => setGitBranch(e.target.value)}
              placeholder="main"
              className="font-mono text-sm"
              aria-invalid={!branchValid ? 'true' : undefined}
            />
          </div>

          {submitError && (
            <p className="text-[11px] text-red-400" role="alert">
              {submitError}
            </p>
          )}

          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={resetAndClose}
              disabled={create.isPending}
            >
              Cancel
            </Button>
            <Button type="submit" size="sm" disabled={!canSubmit} data-testid="brownfield-submit">
              {create.isPending ? 'Registering…' : 'Register'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
