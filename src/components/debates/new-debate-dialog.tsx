'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { GitBranch, Loader2, Sparkles } from 'lucide-react';
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
import { usePartyProjects } from '@/hooks/use-party-projects';
import { useCreateSessionMutation } from '@/hooks/use-party-sessions';

interface NewDebateDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/**
 * Cross-project entry point for starting a debate from the Debates page.
 *
 * Lists every Party project the user has registered (greenfield + brownfield)
 * and lets them pick one + an optional topic. On submit:
 *
 *   - POST /api/party/sessions → new sessionId
 *   - useCreateSessionMutation seeds the per-session cache + invalidates
 *     the cross-project sessions list so the new debate appears in the
 *     Debates index on return
 *   - Router pushes /debates?sessionId=<id> so the user lands in the
 *     full-screen chat with a shareable URL
 *
 * Projects with status other than HEALTHY/DRIFTED are hidden (a brand-new
 * brownfield project that's still INSTALLING shouldn't be debate-able).
 */
export function NewDebateDialog({ open, onOpenChange }: NewDebateDialogProps) {
  const router = useRouter();
  const { data, isLoading } = usePartyProjects(open);
  const create = useCreateSessionMutation();

  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(null);
  const [topic, setTopic] = useState('');
  const [submitError, setSubmitError] = useState<string | null>(null);

  const projects = data?.projects ?? [];
  const debateableProjects = projects.filter(
    (p) => p.bmadStatus === 'HEALTHY' || p.bmadStatus === 'DRIFTED',
  );

  function resetForm() {
    setSelectedProjectId(null);
    setTopic('');
    setSubmitError(null);
  }

  function handleClose(nextOpen: boolean) {
    if (create.isPending) return;
    if (!nextOpen) resetForm();
    onOpenChange(nextOpen);
  }

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    if (!selectedProjectId || create.isPending) return;
    setSubmitError(null);
    try {
      const session = await create.mutateAsync({
        projectId: selectedProjectId,
        topic: topic.trim() || undefined,
      });
      resetForm();
      onOpenChange(false);
      router.push(`/debates?sessionId=${encodeURIComponent(session.sessionId)}`);
    } catch (err) {
      setSubmitError(err instanceof Error ? err.message : 'Failed to start debate');
    }
  }

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent className="sm:max-w-[520px]" data-testid="new-debate-dialog">
        <DialogHeader>
          <DialogTitle>Start a new debate</DialogTitle>
          <DialogDescription>
            Pick a Party project. The debate opens in a shareable URL you can bookmark or open on
            your phone.
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={handleSubmit} className="space-y-3 py-2">
          <div className="space-y-2">
            <Label>Project</Label>

            {isLoading && (
              <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
                <Loader2 className="h-3 w-3 animate-spin" /> Loading projects…
              </div>
            )}

            {!isLoading && debateableProjects.length === 0 && (
              <p className="text-[11px] text-yellow-400">
                No Party projects are ready to debate yet. Register one via the migration runner or
                enable Party Mode on an App.
              </p>
            )}

            {!isLoading && debateableProjects.length > 0 && (
              <div
                role="radiogroup"
                aria-label="Select a Party project"
                className="max-h-[280px] space-y-1 overflow-y-auto"
              >
                {debateableProjects.map((p) => {
                  const isSelected = selectedProjectId === p.projectId;
                  const isBrownfield = p.kind === 'brownfield';
                  return (
                    <button
                      type="button"
                      key={p.projectId}
                      role="radio"
                      aria-checked={isSelected}
                      onClick={() => setSelectedProjectId(p.projectId)}
                      data-testid={`new-debate-project-${p.projectId}`}
                      className={`flex w-full items-start gap-2 rounded-md border px-3 py-2 text-left transition-colors ${
                        isSelected
                          ? 'border-accent-purple bg-accent-purple/10'
                          : 'border-border bg-muted/10 hover:bg-muted/30'
                      }`}
                    >
                      <span className="mt-0.5 shrink-0">
                        {isBrownfield ? (
                          <GitBranch className="h-3.5 w-3.5 text-muted-foreground" />
                        ) : (
                          <Sparkles className="h-3.5 w-3.5 text-accent-purple" />
                        )}
                      </span>
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2">
                          <span className="truncate text-sm font-medium">{p.projectId}</span>
                          <span className="inline-flex shrink-0 items-center rounded-full border border-border bg-muted/40 px-1.5 font-mono text-[10px] text-muted-foreground">
                            {p.kind ?? 'greenfield'}
                          </span>
                          {p.bmadStatus === 'DRIFTED' && (
                            <span className="inline-flex shrink-0 items-center rounded-full border border-yellow-900/60 bg-yellow-900/30 px-1.5 font-mono text-[10px] text-yellow-300">
                              drifted
                            </span>
                          )}
                        </div>
                        {isBrownfield && p.gitRepoUrl && (
                          <div
                            className="truncate font-mono text-[10.5px] text-muted-foreground"
                            title={p.gitRepoUrl}
                          >
                            {p.gitRepoUrl}
                          </div>
                        )}
                        {typeof p.agentCount === 'number' && (
                          <div className="text-[10.5px] text-muted-foreground">
                            {p.agentCount} agents
                          </div>
                        )}
                      </div>
                    </button>
                  );
                })}
              </div>
            )}
          </div>

          <div className="space-y-1">
            <Label htmlFor="new-debate-topic">Topic (optional)</Label>
            <Input
              id="new-debate-topic"
              data-testid="new-debate-topic"
              value={topic}
              onChange={(e) => setTopic(e.target.value)}
              placeholder="What should the team debate?"
              maxLength={200}
            />
            <p className="text-[10.5px] text-muted-foreground">
              Up to 200 characters. Can be edited later.
            </p>
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
              onClick={() => handleClose(false)}
              disabled={create.isPending}
            >
              Cancel
            </Button>
            <Button
              type="submit"
              size="sm"
              disabled={!selectedProjectId || create.isPending}
              data-testid="new-debate-submit"
            >
              {create.isPending ? 'Creating…' : 'Start debate'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
