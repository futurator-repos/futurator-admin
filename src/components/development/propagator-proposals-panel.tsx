'use client';

/**
 * PropagatorProposalsPanel — Epic 6, Story 6.5 (PRD §7.6). The consent gate:
 * the visible end of "propagation is hands-off but never auto-applied without
 * consent". Lists PROPOSED sibling port-briefs and lets an operator approve or
 * reject each — phone-friendly (single-column cards, large tap targets), aligned
 * with the "build the UI, don't auto-bypass" + "party autonomy" principles.
 *
 * Presentational only — the parent owns fetching + the approve/reject calls.
 * Reject captures a short reason (it becomes context for any re-proposal).
 */

import { useState } from 'react';
import type { PropagatorProposal } from '../../../functions/shared/types/propagator';

export interface PropagatorProposalsPanelProps {
  proposals: PropagatorProposal[] | undefined;
  onApprove: (proposalId: string) => void;
  onReject: (proposalId: string, reason: string) => void;
  /** Disable buttons while a decision is in flight. */
  deciding?: boolean;
}

export function PropagatorProposalsPanel({
  proposals,
  onApprove,
  onReject,
  deciding = false,
}: PropagatorProposalsPanelProps) {
  const pending = (proposals ?? []).filter((p) => p.status === 'proposed');

  if (pending.length === 0) {
    return (
      <div
        className="rounded-md border border-border bg-card px-4 py-3 text-xs text-muted-foreground"
        data-testid="propagator-proposals-panel"
      >
        No port-briefs awaiting approval — siblings are up to date with shared contracts.
      </div>
    );
  }

  return (
    <div className="space-y-3" data-testid="propagator-proposals-panel">
      <div className="flex items-center gap-2">
        <span className="text-sm font-semibold">Propagation port-briefs</span>
        <span className="rounded-full bg-warning/15 px-2 py-0.5 text-xs font-medium text-warning">
          {pending.length} awaiting approval
        </span>
      </div>
      {pending.map((p) => (
        <ProposalCard
          key={p.proposalId}
          proposal={p}
          onApprove={onApprove}
          onReject={onReject}
          deciding={deciding}
        />
      ))}
    </div>
  );
}

function ProposalCard({
  proposal,
  onApprove,
  onReject,
  deciding,
}: {
  proposal: PropagatorProposal;
  onApprove: (id: string) => void;
  onReject: (id: string, reason: string) => void;
  deciding: boolean;
}) {
  const [rejecting, setRejecting] = useState(false);
  const [reason, setReason] = useState('');

  return (
    <div className="rounded-md border border-border bg-card p-4">
      <div className="flex flex-wrap items-baseline gap-2">
        <span className="rounded bg-accent-blue/15 px-2 py-0.5 text-xs font-medium text-accent-blue">
          {proposal.sourceProject} → {proposal.sibling}
        </span>
        <span className="text-xs text-muted-foreground">{proposal.trigger}</span>
      </div>

      <p className="mt-2 text-sm font-medium">{proposal.proposedStory.title}</p>
      <p className="mt-1 text-xs text-muted-foreground">{proposal.brief}</p>

      {proposal.contractChanges.length > 0 && (
        <ul className="mt-2 space-y-1">
          {proposal.contractChanges.map((ch, i) => (
            <li key={i} className="text-xs">
              <code className="break-all">{ch.node}</code>
              <span className="ml-1 text-muted-foreground">— {ch.change}</span>
            </li>
          ))}
        </ul>
      )}

      {!rejecting ? (
        <div className="mt-3 flex gap-2">
          <button
            type="button"
            disabled={deciding}
            onClick={() => onApprove(proposal.proposalId)}
            className="flex-1 rounded-md bg-success px-3 py-2 text-sm font-medium text-success-foreground hover:opacity-90 disabled:opacity-50"
          >
            Approve
          </button>
          <button
            type="button"
            disabled={deciding}
            onClick={() => setRejecting(true)}
            className="flex-1 rounded-md border border-border px-3 py-2 text-sm font-medium hover:bg-muted/40 disabled:opacity-50"
          >
            Reject
          </button>
        </div>
      ) : (
        <div className="mt-3 space-y-2">
          <textarea
            aria-label="Rejection reason"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="Why reject? (becomes context for any re-proposal)"
            className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm"
            rows={2}
          />
          <div className="flex gap-2">
            <button
              type="button"
              disabled={deciding || reason.trim().length < 3}
              onClick={() => onReject(proposal.proposalId, reason.trim())}
              className="flex-1 rounded-md bg-destructive px-3 py-2 text-sm font-medium text-destructive-foreground hover:opacity-90 disabled:opacity-50"
            >
              Confirm reject
            </button>
            <button
              type="button"
              onClick={() => setRejecting(false)}
              className="flex-1 rounded-md border border-border px-3 py-2 text-sm font-medium hover:bg-muted/40"
            >
              Cancel
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
