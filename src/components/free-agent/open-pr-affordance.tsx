'use client';
/**
 * OpenPrAffordance — 2026-05-27 PR B.e.
 *
 * Slim row between the message thread and the composer that lets the
 * operator launch the agent's PR flow. Renders only when there's an active
 * session, no in-flight merge card, and the agent has produced ≥1 turn
 * (so there's plausibly something to commit).
 *
 * The actual "are there commits to push?" check happens server-side in
 * the open-pr endpoint via SSM `git rev-list --count main..HEAD` — this
 * UI is a hint, not a gate. The server's NO_COMMITS_TO_PUSH error is
 * surfaced inline if the operator taps with an empty diff.
 */

import { useState } from 'react';
import { GitPullRequest, Loader2, X } from 'lucide-react';
import { useOpenPr } from '@/hooks/use-free-agent-merge';

export interface OpenPrAffordanceProps {
  sessionId: string | null;
  /** Hide entirely when this is true (e.g., an OPEN merge bubble is already in the thread). */
  hasOpenPr: boolean;
  /** Hide when no turns have run yet. */
  turnCount: number;
}

export function OpenPrAffordance({ sessionId, hasOpenPr, turnCount }: OpenPrAffordanceProps) {
  const [showModal, setShowModal] = useState(false);
  const [title, setTitle] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const openPr = useOpenPr(sessionId);

  if (!sessionId || hasOpenPr || turnCount === 0) return null;

  const onLaunch = () => {
    if (!title.trim() || openPr.isPending) return;
    setErr(null);
    openPr.mutate(
      { title: title.trim() },
      {
        onSuccess: () => {
          setShowModal(false);
          setTitle('');
        },
        onError: (e) => {
          const msg = e instanceof Error ? e.message : String(e);
          setErr(msg);
        },
      },
    );
  };

  return (
    <>
      <div className="border-t border-border bg-card/50 px-3 py-1.5">
        <button
          type="button"
          onClick={() => setShowModal(true)}
          className="inline-flex h-7 items-center gap-1.5 rounded-md border border-border bg-background px-2 text-[12px] text-muted-foreground hover:text-foreground hover:bg-muted"
        >
          <GitPullRequest className="h-3 w-3" />
          Open PR
        </button>
      </div>

      {showModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
          <div className="w-full max-w-md rounded-lg border border-border bg-card p-4 shadow-xl">
            <div className="flex items-center justify-between">
              <span className="text-[14px] font-medium text-foreground">
                Open PR from this session
              </span>
              <button
                type="button"
                onClick={() => {
                  setShowModal(false);
                  setErr(null);
                }}
                disabled={openPr.isPending}
                className="rounded p-1 text-muted-foreground hover:text-foreground"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </div>
            <p className="mt-1 text-[12px] text-muted-foreground">
              Pushes the assist branch and opens a PR against the project&apos;s default branch.
              Classification + inline merge-approval card follow.
            </p>
            <label className="mt-3 block text-[12px] font-medium text-foreground">PR title</label>
            <input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder={'e.g. "Add cohort scoring helper"'}
              autoFocus
              maxLength={120}
              className="mt-1 w-full rounded-md border border-border bg-background px-2 py-1.5 text-[13px] focus:outline-none focus:ring-1 focus:ring-ring"
            />
            {err && (
              <div className="mt-2 rounded border border-destructive/40 bg-destructive/10 px-2 py-1 text-[12px] text-destructive">
                {err}
              </div>
            )}
            <div className="mt-3 flex items-center justify-end gap-2">
              <button
                type="button"
                onClick={() => {
                  setShowModal(false);
                  setErr(null);
                }}
                disabled={openPr.isPending}
                className="rounded-md border border-border bg-card px-2 py-1 text-[12px] text-muted-foreground hover:text-foreground"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={onLaunch}
                disabled={!title.trim() || openPr.isPending}
                className="rounded-md border border-success/40 bg-success/15 px-2 py-1 text-[12px] font-medium text-success hover:bg-success/25 disabled:cursor-wait disabled:opacity-60"
              >
                {openPr.isPending ? <Loader2 className="inline h-3 w-3 animate-spin" /> : 'Open PR'}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
