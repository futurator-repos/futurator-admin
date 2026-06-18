import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api-client';
import type { ConceptArtifact, ConceptArtifactKind } from '@/types/plan';

interface DriveResponse {
  planId: string;
  drive: { kind: string; reason?: string; artifact?: ConceptArtifactKind };
  conceptArtifacts: ConceptArtifact[];
  status?: string;
  epicCount?: number;
}

/**
 * Concept v2 (Round 1) — reactive drive tick. While the concept chain is live
 * (status `concept`, a conceptPlan exists, no epics yet) this polls the drive
 * endpoint every few seconds so the DAG advances within seconds of a generator
 * finishing — instead of waiting for the cron backstop (the "nothing happens"
 * gap). Each tick applies completed generators + enqueues the next step, and
 * invalidates the plan query so the rail re-renders with live status.
 */
export function useConceptDrive(planId: string, enabled: boolean) {
  const qc = useQueryClient();
  return useQuery({
    queryKey: ['concept-drive', planId],
    enabled,
    refetchInterval: enabled ? 4000 : false,
    refetchIntervalInBackground: false,
    queryFn: async () => {
      const res = await api.post<DriveResponse>(`/plans/${planId}/concept/drive`, {});
      // A drive that changed state → refresh the plan so the rail + epics update.
      if (res.drive?.kind && res.drive.kind !== 'noop' && res.drive.kind !== 'awaiting-approval') {
        qc.invalidateQueries({ queryKey: ['plans', planId] });
      }
      return res;
    },
  });
}

export interface ConceptDocumentResponse {
  planId: string;
  kind: ConceptArtifactKind;
  markdown: string | null;
  status: string | null;
  rev: number;
  persona?: string;
}

/**
 * Concept v2 — fetch a generated artifact's full markdown so the operator can
 * READ the PRD/UX/Architecture in a drawer before approving it. Enabled only
 * when a drawer is open for a kind. Re-fetches on demand (a regenerate bumps the
 * content); polls lightly while the doc is still being drafted.
 */
export function useConceptDocument(
  planId: string,
  kind: ConceptArtifactKind | null,
  opts?: { stillGenerating?: boolean },
) {
  return useQuery({
    queryKey: ['concept-document', planId, kind],
    enabled: !!kind,
    refetchInterval: opts?.stillGenerating ? 3000 : false,
    queryFn: () => api.get<ConceptDocumentResponse>(`/plans/${planId}/concept/${kind}/document`),
  });
}

/** Concept v2 — regenerate a drafted/stale artifact (operator-triggered refresh). */
export function useRegenerateConceptArtifact(planId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (kind: ConceptArtifactKind) =>
      api.post(`/plans/${planId}/concept/${kind}/regenerate`, {}),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['plans', planId] });
    },
  });
}

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
