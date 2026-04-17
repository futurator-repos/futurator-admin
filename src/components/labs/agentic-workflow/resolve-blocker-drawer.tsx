'use client';
import { useState, useEffect } from 'react';
import { XIcon, Loader2 } from 'lucide-react';
import { Dialog as DialogPrimitive } from '@base-ui/react/dialog';
import {
  useResolveBlocker,
  isBlockerChangedError,
  type ResolveBlockerBody,
} from '@/hooks/use-resolve-blocker';
import type {
  BlockerResolutionAction,
  EpicStory,
  StoryComplexity,
  ReviewRigor,
} from '@/types/epic-workflow';

interface ResolveBlockerDrawerProps {
  epicId: string;
  story: EpicStory | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

const ACTION_LABEL: Record<BlockerResolutionAction, string> = {
  amend: 'Amend story',
  skip: 'Skip this story',
  retry: 'Retry without changes',
};

function formatRelative(iso: string): string {
  const delta = Date.now() - new Date(iso).getTime();
  const seconds = Math.floor(delta / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  const mins = Math.floor(seconds / 60);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return new Date(iso).toLocaleDateString();
}

export function ResolveBlockerDrawer({
  epicId,
  story,
  open,
  onOpenChange,
}: ResolveBlockerDrawerProps) {
  const resolve = useResolveBlocker(epicId);
  const [action, setAction] = useState<BlockerResolutionAction>('amend');
  const [reason, setReason] = useState('');

  // Amend fields
  const [amendTitle, setAmendTitle] = useState('');
  const [amendTouchPoints, setAmendTouchPoints] = useState('');
  const [amendComplexity, setAmendComplexity] = useState<StoryComplexity | ''>('');
  const [amendReviewRigor, setAmendReviewRigor] = useState<ReviewRigor | ''>('');

  // Retry
  const [resumeImmediately, setResumeImmediately] = useState(true);

  const [blockerChanged, setBlockerChanged] = useState(false);

  useEffect(() => {
    if (open && story) {
      setAction('amend');
      setReason('');
      setAmendTitle('');
      setAmendTouchPoints((story.touchPoints ?? []).join(', '));
      setAmendComplexity(story.complexity ?? '');
      setAmendReviewRigor(story.reviewRigor ?? '');
      setResumeImmediately(true);
      setBlockerChanged(false);
      resolve.reset();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, story?.storyId]);

  if (!story) return null;

  const blocker = story.blocker;

  const buildAmendedStory = (): ResolveBlockerBody extends infer T
    ? T extends { action: 'amend'; amendedStory: infer A }
      ? A
      : never
    : never => {
    const amended: Record<string, unknown> = {};
    if (amendTitle.trim() && amendTitle.trim() !== story.title) {
      amended.title = amendTitle.trim();
    }
    if (amendTouchPoints.trim()) {
      const next = amendTouchPoints
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
      const prev = story.touchPoints ?? [];
      if (next.length > 0 && JSON.stringify(next) !== JSON.stringify(prev)) {
        amended.touchPoints = next;
      }
    }
    if (amendComplexity && amendComplexity !== story.complexity) {
      amended.complexity = amendComplexity;
    }
    if (amendReviewRigor && amendReviewRigor !== story.reviewRigor) {
      amended.reviewRigor = amendReviewRigor;
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return amended as any;
  };

  const canSubmit = reason.trim().length > 0 && !resolve.isPending;

  const handleSubmit = async () => {
    if (!canSubmit) return;
    setBlockerChanged(false);

    let body: ResolveBlockerBody;
    if (action === 'amend') {
      const amendedStory = buildAmendedStory();
      if (!amendedStory || Object.keys(amendedStory).length === 0) {
        alert('Change at least one field to amend, or pick Retry/Skip instead.');
        return;
      }
      body = {
        action: 'amend',
        amendedStory,
        reason: reason.trim(),
        expectedBlockerReportedAt: blocker?.reportedAt,
      };
    } else if (action === 'skip') {
      body = {
        action: 'skip',
        reason: reason.trim(),
        expectedBlockerReportedAt: blocker?.reportedAt,
      };
    } else {
      body = {
        action: 'retry',
        reason: reason.trim(),
        resumeImmediately,
        expectedBlockerReportedAt: blocker?.reportedAt,
      };
    }

    try {
      await resolve.mutateAsync({ storyId: story.storyId, body });
      onOpenChange(false);
    } catch (err) {
      if (isBlockerChangedError(err)) {
        setBlockerChanged(true);
      }
    }
  };

  return (
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Backdrop className="fixed inset-0 z-50 bg-black/40 data-open:animate-in data-closed:animate-out data-open:fade-in-0 data-closed:fade-out-0" />
        <DialogPrimitive.Popup className="fixed right-0 top-0 bottom-0 z-50 w-full max-w-[540px] bg-popover text-popover-foreground shadow-xl border-l border-border flex flex-col outline-none data-open:animate-in data-closed:animate-out data-open:slide-in-from-right data-closed:slide-out-to-right">
          <header className="flex items-center justify-between px-4 py-3 border-b border-border">
            <div>
              <DialogPrimitive.Title className="font-heading text-base font-medium">
                Resolve Blocker — {story.storyId}
              </DialogPrimitive.Title>
              <p className="text-xs text-muted-foreground mt-0.5 truncate max-w-[440px]">
                {story.title}
              </p>
            </div>
            <DialogPrimitive.Close
              aria-label="Close"
              className="text-muted-foreground hover:text-foreground p-1 rounded transition-colors"
            >
              <XIcon className="h-4 w-4" />
            </DialogPrimitive.Close>
          </header>

          <div className="flex-1 overflow-y-auto p-4 space-y-4">
            {blockerChanged && (
              <div className="rounded border border-amber-500/40 bg-amber-500/10 p-3 text-xs flex items-center justify-between gap-3">
                <span className="text-amber-300">
                  This blocker has been updated since you opened the drawer. Reload the story to see
                  the latest state.
                </span>
                <button
                  onClick={() => onOpenChange(false)}
                  className="rounded bg-amber-500/80 px-3 py-1 text-xs text-white hover:bg-amber-500"
                >
                  Reload
                </button>
              </div>
            )}

            {/* Current blocker */}
            {blocker && (
              <section>
                <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wide mb-2">
                  Current blocker
                </h3>
                <div className="rounded border border-border/50 bg-secondary/20 p-3 text-xs space-y-1.5">
                  <Field label="Code" value={blocker.code} mono />
                  <Field label="Severity" value={blocker.severity} />
                  <Field
                    label="Attempts"
                    value={`${blocker.reportedByAttempt} (of ${blocker.attemptsBeforeBlock + 1})`}
                  />
                  <Field label="Reported" value={formatRelative(blocker.reportedAt)} />
                  {blocker.subagentId && <Field label="Subagent" value={blocker.subagentId} mono />}
                </div>
                <div className="mt-2 space-y-2 text-xs">
                  <div>
                    <span className="font-medium">Description</span>
                    <p className="text-muted-foreground mt-1 whitespace-pre-wrap">
                      {blocker.description}
                    </p>
                  </div>
                  <div>
                    <span className="font-medium">Suggested resolution</span>
                    <p className="text-muted-foreground mt-1 whitespace-pre-wrap">
                      {blocker.suggestedResolution || '(none provided)'}
                    </p>
                  </div>
                  {blocker.affectedPath && (
                    <div>
                      <span className="font-medium">Affected path</span>
                      <p className="text-muted-foreground mt-1 font-mono">{blocker.affectedPath}</p>
                    </div>
                  )}
                </div>
              </section>
            )}

            {/* Action picker */}
            <section>
              <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wide mb-2">
                Action
              </h3>
              <div className="space-y-2">
                {(['amend', 'skip', 'retry'] as const).map((a) => (
                  <label
                    key={a}
                    className={`flex items-start gap-2 rounded border px-3 py-2 cursor-pointer transition-colors ${
                      action === a
                        ? 'border-primary bg-primary/5'
                        : 'border-border/50 hover:border-border'
                    }`}
                  >
                    <input
                      type="radio"
                      name="resolve-action"
                      checked={action === a}
                      onChange={() => setAction(a)}
                      className="mt-0.5"
                    />
                    <div className="flex-1">
                      <div className="text-sm font-medium">{ACTION_LABEL[a]}</div>
                      <div className="text-xs text-muted-foreground mt-0.5">
                        {a === 'amend' &&
                          'Edit story fields (AC, touch points, complexity) and re-run.'}
                        {a === 'skip' &&
                          'Exclude this story from the epic. No rebuild will be queued.'}
                        {a === 'retry' &&
                          'Re-run the story with the current spec (after fixing something external).'}
                      </div>
                    </div>
                  </label>
                ))}
              </div>
            </section>

            {/* Sub-forms */}
            {action === 'amend' && (
              <section className="space-y-3">
                <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">
                  Amend fields (leave blank to keep current)
                </h3>
                <div>
                  <label className="text-xs text-muted-foreground">Title</label>
                  <input
                    value={amendTitle}
                    onChange={(e) => setAmendTitle(e.target.value)}
                    placeholder={story.title}
                    className="w-full rounded border border-input bg-background px-2 py-1.5 text-sm mt-1"
                  />
                </div>
                <div>
                  <label className="text-xs text-muted-foreground">
                    Touch points (comma-separated)
                  </label>
                  <textarea
                    value={amendTouchPoints}
                    onChange={(e) => setAmendTouchPoints(e.target.value)}
                    rows={2}
                    className="w-full rounded border border-input bg-background px-2 py-1.5 text-sm font-mono mt-1"
                  />
                </div>
                <div className="flex gap-2">
                  <div className="flex-1">
                    <label className="text-xs text-muted-foreground">Complexity</label>
                    <select
                      value={amendComplexity}
                      onChange={(e) =>
                        setAmendComplexity((e.target.value as StoryComplexity) || '')
                      }
                      className="w-full rounded border border-input bg-background px-2 py-1.5 text-sm mt-1"
                    >
                      <option value="">Keep ({story.complexity ?? 'unset'})</option>
                      <option value="trivial">trivial</option>
                      <option value="standard">standard</option>
                      <option value="complex">complex</option>
                      <option value="architectural">architectural</option>
                    </select>
                  </div>
                  <div className="flex-1">
                    <label className="text-xs text-muted-foreground">Review rigor</label>
                    <select
                      value={amendReviewRigor}
                      onChange={(e) => setAmendReviewRigor((e.target.value as ReviewRigor) || '')}
                      className="w-full rounded border border-input bg-background px-2 py-1.5 text-sm mt-1"
                    >
                      <option value="">Keep ({story.reviewRigor ?? 'unset'})</option>
                      <option value="light">light</option>
                      <option value="standard">standard</option>
                      <option value="strict">strict</option>
                    </select>
                  </div>
                </div>
              </section>
            )}

            {action === 'skip' && (
              <div className="rounded bg-muted/40 p-3 text-xs text-muted-foreground">
                Skipping means this story will not land in this epic. You can add it to a future
                epic later. No rebuild will be queued.
              </div>
            )}

            {action === 'retry' && (
              <label className="flex items-start gap-2 text-xs">
                <input
                  type="checkbox"
                  checked={resumeImmediately}
                  onChange={(e) => setResumeImmediately(e.target.checked)}
                  className="mt-0.5"
                />
                <span>
                  <span className="font-medium">Resume immediately</span>
                  <span className="text-muted-foreground">
                    {' '}
                    — uncheck to review before manually triggering the next run.
                  </span>
                </span>
              </label>
            )}

            {/* Reason */}
            <section>
              <label className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">
                Reason (required)
              </label>
              <textarea
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                rows={3}
                maxLength={1000}
                placeholder="Audit trail — describe what you're doing and why."
                className="w-full rounded border border-input bg-background px-2 py-1.5 text-sm mt-1"
              />
              <p className="text-[10px] text-muted-foreground mt-1">
                {reason.length}/1000 characters
              </p>
            </section>

            {resolve.error && !blockerChanged && (
              <div className="rounded border border-red-500/40 bg-red-500/10 p-3 text-xs text-red-400">
                {resolve.error instanceof Error ? resolve.error.message : 'Failed to resolve'}
              </div>
            )}
          </div>

          <footer className="flex items-center justify-end gap-2 px-4 py-3 border-t border-border bg-muted/20">
            <button
              onClick={() => onOpenChange(false)}
              className="rounded border border-border/50 px-3 py-1.5 text-sm hover:bg-secondary/40"
            >
              Cancel
            </button>
            <button
              onClick={handleSubmit}
              disabled={!canSubmit}
              className="rounded bg-primary px-3 py-1.5 text-sm text-primary-foreground hover:bg-primary/90 disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-1.5"
            >
              {resolve.isPending && <Loader2 className="h-3 w-3 animate-spin" />}
              Apply
            </button>
          </footer>
        </DialogPrimitive.Popup>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}

function Field({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex gap-2">
      <span className="text-muted-foreground w-20 shrink-0">{label}:</span>
      <span className={mono ? 'font-mono' : ''}>{value}</span>
    </div>
  );
}
