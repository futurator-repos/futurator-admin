/**
 * Propagator types — Epic 6, Story 6.5 (PRD §7.4–7.6, Appendix E).
 *
 * A PROPAGATOR proposal is a CONSENT-GATED, substrate-targeted port-brief filed
 * as a PROPOSED story for a sibling pipeline. It is NEVER auto-merged: a human
 * approves or rejects it (phone-friendly), and the source contract's
 * `lastPropagatedTo` marker only advances when the sibling's port story reaches
 * Done — which is what prevents the same change from re-briefing forever.
 *
 * The daemon-side brain (`daemon/scripts/propagator.mjs`) produces these rows;
 * this is their shape as they live in DynamoDB and traverse the API.
 */

export type PropagatorProposalStatus = 'proposed' | 'approved' | 'rejected' | 'done';

export type PropagatorTrigger = 'wave-gate' | 'drift-threshold';

export interface PropagatorContractChange {
  /** Shared-contract node id this change lands on. */
  node: string;
  /** Shape-keyed change description, e.g. `field +dependsOn:string[]` or `new`. */
  change: string;
}

export interface PropagatorProposedStory {
  title: string;
  epic: string;
}

/** Stored row + API shape. `proposalId` is the DynamoDB partition key. */
export interface PropagatorProposal {
  /** DDB partition key — `prop/<source>-><sibling>/<commit|ts>`. */
  proposalId: string;
  /** Project the contract change originated in (e.g. `labs`). */
  sourceProject: string;
  /** Sibling pipeline the brief targets (e.g. `mobile`, `office`). */
  sibling: string;
  /** What fired the proposal. */
  trigger: PropagatorTrigger;
  /** Consent-gate lifecycle. */
  status: PropagatorProposalStatus;
  /** Always true — drafts are proposed, humans approve. */
  requiresApproval: boolean;
  /** Substrate-targeted port-brief prose. */
  brief: string;
  /** The contract changes that justify the brief (audit trail). */
  contractChanges: PropagatorContractChange[];
  /** The story this would file in the sibling's pipeline. */
  proposedStory: PropagatorProposedStory;
  /** Commit the source change landed at (stamped onto the marker on Done). */
  atCommit?: string | null;
  /** ISO timestamp the proposal was filed. */
  createdAt: string;
  /** ISO timestamp the operator approved / rejected. */
  decidedAt?: string;
  /** Operator who decided. */
  decidedBy?: string;
  /** Reason captured on reject (becomes context for re-proposal). */
  rejectionReason?: string;
  /** Set when an approved proposal is enqueued as a sibling agent-job. */
  siblingJobId?: string;
}
