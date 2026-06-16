'use client';
/**
 * use-propagator-proposals.ts — Epic 6, Story 6.5.
 *
 * TanStack Query hooks for the consent-gated PROPAGATOR queue: list proposed
 * sibling port-briefs and approve / reject them (phone-friendly). Mirrors the
 * `use-qa-report` mutation conventions. Paths omit the `/api` prefix — the
 * api-client base already ends in `/api`.
 */

import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api-client';
import type {
  PropagatorProposal,
  PropagatorProposalStatus,
} from '../../functions/shared/types/propagator';

export interface PropagatorProposalListResponse {
  items: PropagatorProposal[];
  pendingCount: number;
  total: number;
}

/** List proposals, optionally filtered by status / sibling / source project. */
export function usePropagatorProposals(
  args: { status?: PropagatorProposalStatus; sibling?: string; sourceProject?: string } = {},
) {
  const params = new URLSearchParams();
  if (args.status) params.set('status', args.status);
  if (args.sibling) params.set('sibling', args.sibling);
  if (args.sourceProject) params.set('sourceProject', args.sourceProject);
  const qs = params.toString();
  const url = qs ? `/propagator/proposals?${qs}` : '/propagator/proposals';

  return useQuery({
    queryKey: [
      'propagator-proposals',
      args.status ?? null,
      args.sibling ?? null,
      args.sourceProject ?? null,
    ],
    queryFn: () => api.get<PropagatorProposalListResponse>(url),
    refetchInterval: 30_000,
  });
}

export function useApprovePropagatorProposal() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (proposalId: string) =>
      api.post<{ item: PropagatorProposal }>(
        `/propagator/proposals/${encodeURIComponent(proposalId)}/approve`,
        {},
      ),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['propagator-proposals'] });
    },
  });
}

export function useRejectPropagatorProposal() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (args: { proposalId: string; reason: string }) =>
      api.post<{ item: PropagatorProposal }>(
        `/propagator/proposals/${encodeURIComponent(args.proposalId)}/reject`,
        { reason: args.reason },
      ),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['propagator-proposals'] });
    },
  });
}
