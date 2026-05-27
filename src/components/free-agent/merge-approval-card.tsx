'use client';
/**
 * MergeApprovalCard — 2026-05-27 PR B.e.
 *
 * Inline card the Free Agent renders in its chat stream after `/open-pr`
 * succeeds. Shows:
 *   - PR number + title (link to GitHub)
 *   - Diff summary (file count + line counts)
 *   - Risk class chip (green/yellow/red)
 *   - Risk-classification reasons
 *   - [Approve] + [Reject] buttons
 *   - For red class: [Approve] swaps to a typed-confirmation modal that
 *     requires the operator to retype the PR title verbatim before merging
 *
 * After approve/reject completes, the card transitions to a terminal state
 * (✅ Merged / ✕ Rejected) so the operator's chat history shows the
 * decision permanently.
 */

import { useState } from 'react';
import { Check, ExternalLink, Loader2, ShieldAlert, X } from 'lucide-react';
import { useApproveMerge, useRejectMerge } from '@/hooks/use-free-agent-merge';

export interface MergeApprovalCardProps {
  sessionId: string;
  prNumber: number;
  prUrl: string;
  prTitle: string;
  riskClass: 'red' | 'yellow' | 'green';
  riskReasons: string[];
  diffSummary: { additions: number; deletions: number; filesChanged: number };
  /** 'OPEN' on initial render; transitions on approve/reject events. */
  state: 'OPEN' | 'MERGED' | 'CLOSED';
}

function RiskChip({ riskClass }: { riskClass: 'red' | 'yellow' | 'green' }) {
  const colors = {
    red: 'border-destructive/40 bg-destructive/10 text-destructive',
    yellow: 'border-warning/40 bg-warning/10 text-warning',
    green: 'border-success/40 bg-success/10 text-success',
  } as const;
  return (
    <span
      className={[
        'inline-flex items-center rounded-md border px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide',
        colors[riskClass],
      ].join(' ')}
    >
      {riskClass}
    </span>
  );
}

export function MergeApprovalCard(props: MergeApprovalCardProps) {
  const approve = useApproveMerge(props.sessionId);
  const reject = useRejectMerge(props.sessionId);

  const [typedConfirmation, setTypedConfirmation] = useState('');
  const [showRejectModal, setShowRejectModal] = useState(false);
  const [rejectReason, setRejectReason] = useState('');
  const [showRedModal, setShowRedModal] = useState(false);

  const isBusy = approve.isPending || reject.isPending;

  if (props.state === 'MERGED') {
    return (
      <div className="rounded-md border border-success/40 bg-success/5 px-3 py-2 text-[13px]">
        <div className="flex items-center gap-2">
          <Check className="h-4 w-4 text-success" />
          <span className="font-medium text-foreground">PR #{props.prNumber} merged</span>
          <a
            href={props.prUrl}
            target="_blank"
            rel="noreferrer"
            className="ml-auto text-[12px] text-muted-foreground hover:text-foreground"
          >
            View on GitHub <ExternalLink className="inline h-3 w-3" />
          </a>
        </div>
      </div>
    );
  }

  if (props.state === 'CLOSED') {
    return (
      <div className="rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-[13px]">
        <div className="flex items-center gap-2">
          <X className="h-4 w-4 text-destructive" />
          <span className="font-medium text-foreground">PR #{props.prNumber} rejected</span>
          <a
            href={props.prUrl}
            target="_blank"
            rel="noreferrer"
            className="ml-auto text-[12px] text-muted-foreground hover:text-foreground"
          >
            View on GitHub <ExternalLink className="inline h-3 w-3" />
          </a>
        </div>
      </div>
    );
  }

  const onApprove = () => {
    if (isBusy) return;
    if (props.riskClass === 'red') {
      setShowRedModal(true);
      return;
    }
    approve.mutate({});
  };

  const onConfirmRedMerge = () => {
    if (isBusy) return;
    approve.mutate({ typedConfirmation }, { onSuccess: () => setShowRedModal(false) });
  };

  const onConfirmReject = () => {
    if (isBusy || !rejectReason.trim()) return;
    reject.mutate({ reason: rejectReason.trim() }, { onSuccess: () => setShowRejectModal(false) });
  };

  return (
    <div className="rounded-md border border-border bg-card px-3 py-2.5">
      <div className="flex items-start gap-2">
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <div className="flex items-center gap-2 text-[13px]">
            <RiskChip riskClass={props.riskClass} />
            <a
              href={props.prUrl}
              target="_blank"
              rel="noreferrer"
              className="truncate font-medium text-foreground hover:underline"
              title={props.prTitle}
            >
              #{props.prNumber} {props.prTitle}
            </a>
          </div>
          <div className="text-[12px] text-muted-foreground">
            {props.diffSummary.filesChanged} file
            {props.diffSummary.filesChanged === 1 ? '' : 's'}, +{props.diffSummary.additions} / -
            {props.diffSummary.deletions}
          </div>
          {props.riskReasons.length > 0 && (
            <details className="mt-1 text-[11px] text-muted-foreground">
              <summary className="cursor-pointer hover:text-foreground">
                {props.riskReasons.length} risk reason{props.riskReasons.length === 1 ? '' : 's'}
              </summary>
              <ul className="ml-3 mt-1 list-disc space-y-0.5">
                {props.riskReasons.map((r, i) => (
                  <li key={i}>{r}</li>
                ))}
              </ul>
            </details>
          )}
        </div>
      </div>

      <div className="mt-2.5 flex items-center justify-end gap-2">
        <button
          type="button"
          onClick={() => setShowRejectModal(true)}
          disabled={isBusy}
          className="inline-flex h-7 items-center gap-1 rounded-md border border-border bg-card px-2 text-[12px] text-muted-foreground hover:text-foreground hover:bg-muted disabled:cursor-wait disabled:opacity-60"
        >
          <X className="h-3 w-3" /> Reject
        </button>
        <button
          type="button"
          onClick={onApprove}
          disabled={isBusy}
          className={[
            'inline-flex h-7 items-center gap-1 rounded-md border px-2 text-[12px] font-medium disabled:cursor-wait disabled:opacity-60',
            props.riskClass === 'red'
              ? 'border-destructive/40 bg-destructive/15 text-destructive hover:bg-destructive/25'
              : 'border-success/40 bg-success/15 text-success hover:bg-success/25',
          ].join(' ')}
        >
          {approve.isPending ? (
            <Loader2 className="h-3 w-3 animate-spin" />
          ) : props.riskClass === 'red' ? (
            <ShieldAlert className="h-3 w-3" />
          ) : (
            <Check className="h-3 w-3" />
          )}
          {props.riskClass === 'red' ? 'Approve (typed confirm)' : 'Approve & merge'}
        </button>
      </div>

      {/* Reject + Explain modal */}
      {showRejectModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
          <div className="w-full max-w-md rounded-lg border border-border bg-card p-4 shadow-xl">
            <div className="text-[14px] font-medium text-foreground">Reject + explain</div>
            <p className="mt-1 text-[12px] text-muted-foreground">
              The reason becomes the next user-turn so the agent can revise.
            </p>
            <textarea
              value={rejectReason}
              onChange={(e) => setRejectReason(e.target.value)}
              rows={4}
              placeholder='e.g. "Use Map instead of an object for the new cache"'
              className="mt-2 w-full rounded-md border border-border bg-background px-2 py-1.5 text-[13px] focus:outline-none focus:ring-1 focus:ring-ring"
            />
            <div className="mt-3 flex items-center justify-end gap-2">
              <button
                type="button"
                onClick={() => setShowRejectModal(false)}
                disabled={isBusy}
                className="rounded-md border border-border bg-card px-2 py-1 text-[12px] text-muted-foreground hover:text-foreground"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={onConfirmReject}
                disabled={isBusy || !rejectReason.trim()}
                className="rounded-md border border-destructive/40 bg-destructive/15 px-2 py-1 text-[12px] font-medium text-destructive hover:bg-destructive/25 disabled:cursor-wait disabled:opacity-60"
              >
                {reject.isPending ? <Loader2 className="inline h-3 w-3 animate-spin" /> : 'Reject'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Red-class typed-confirmation modal */}
      {showRedModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
          <div className="w-full max-w-md rounded-lg border border-destructive/40 bg-card p-4 shadow-xl">
            <div className="flex items-center gap-2">
              <ShieldAlert className="h-4 w-4 text-destructive" />
              <span className="text-[14px] font-medium text-foreground">
                Red-class merge: typed confirmation required
              </span>
            </div>
            <p className="mt-2 text-[12px] text-muted-foreground">
              This PR touches load-bearing infrastructure. Type the PR title verbatim to confirm:
            </p>
            <div className="mt-2 rounded-md border border-border bg-muted px-2 py-1 font-mono text-[12px] text-foreground">
              {props.prTitle}
            </div>
            <input
              value={typedConfirmation}
              onChange={(e) => setTypedConfirmation(e.target.value)}
              placeholder="Retype the title here"
              className="mt-2 w-full rounded-md border border-border bg-background px-2 py-1.5 text-[13px] focus:outline-none focus:ring-1 focus:ring-ring"
              autoFocus
            />
            <div className="mt-3 flex items-center justify-end gap-2">
              <button
                type="button"
                onClick={() => {
                  setShowRedModal(false);
                  setTypedConfirmation('');
                }}
                disabled={isBusy}
                className="rounded-md border border-border bg-card px-2 py-1 text-[12px] text-muted-foreground hover:text-foreground"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={onConfirmRedMerge}
                disabled={isBusy || typedConfirmation !== props.prTitle}
                className="rounded-md border border-destructive/40 bg-destructive/15 px-2 py-1 text-[12px] font-medium text-destructive hover:bg-destructive/25 disabled:cursor-wait disabled:opacity-60"
              >
                {approve.isPending ? <Loader2 className="inline h-3 w-3 animate-spin" /> : 'Merge'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
