'use client';

/**
 * PropagatorProposalsSection — Epic 6, Story 6.5. Smart container that wires the
 * consent-gated proposals queue (list + approve/reject hooks) to the
 * presentational panel. Mounted on the Development → Graph page so propagation
 * decisions live next to the federated contract spine that produces them.
 */

import {
  usePropagatorProposals,
  useApprovePropagatorProposal,
  useRejectPropagatorProposal,
} from '@/hooks/use-propagator-proposals';
import { PropagatorProposalsPanel } from './propagator-proposals-panel';

export function PropagatorProposalsSection() {
  const { data } = usePropagatorProposals({ status: 'proposed' });
  const approve = useApprovePropagatorProposal();
  const reject = useRejectPropagatorProposal();

  // Nothing proposed yet → render nothing (keeps the Graph tab quiet until the
  // PROPAGATOR has actually filed a brief).
  if (!data || data.items.length === 0) return null;

  return (
    <PropagatorProposalsPanel
      proposals={data.items}
      onApprove={(proposalId) => approve.mutate(proposalId)}
      onReject={(proposalId, reason) => reject.mutate({ proposalId, reason })}
      deciding={approve.isPending || reject.isPending}
    />
  );
}
