import { useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api-client';
import type { ConceptArtifactKind } from '@/types/plan';

/**
 * Concept v2 (E12.5, Round 1) — approve a drafted concept artifact (PRD/UX/
 * Architecture). POSTs to the existing approve endpoint, which promotes the
 * draft (`recordApproval`) AND drives the chain forward (driveConcept) — so the
 * next artifact's draft generates, or, once all are approved, the grounded
 * pm-plan is enqueued. Invalidates the plan query so the rail reflects the new
 * status + the next awaiting-approval node.
 */
export function useApproveConceptArtifact(planId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (kind: ConceptArtifactKind) =>
      api.post<{ planId: string; kind: ConceptArtifactKind; approved: boolean }>(
        `/plans/${planId}/concept/${kind}/approve`,
        {},
      ),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['plans', planId] });
      qc.invalidateQueries({ queryKey: ['plans'] });
    },
  });
}
