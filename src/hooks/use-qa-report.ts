'use client';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api-client';
import type { QaReport } from '@/types/qa-report';

/**
 * Fetch the plan-wide QA report. Polls every 3s while any QA or PO job is
 * still running (verdict === 'not-run' or 'needs-attention' with pending
 * items); slows to 20s once the report is stable.
 */
export function useQaReport(planId: string | null) {
  return useQuery({
    queryKey: ['qa-report', planId],
    queryFn: () => api.get<QaReport>(`/plans/${planId}/qa-report`),
    enabled: !!planId,
    staleTime: 3_000,
    refetchInterval: (query) => {
      const report = query.state.data;
      if (!report) return 5_000;
      // Keep polling while pillars are pending (a QA job is in-flight) or
      // we've never run. Stable reports settle at 20s to stay responsive to
      // new attention items without hammering the API.
      const pending =
        report.ac.verdict === 'pending' ||
        report.vqa.verdict === 'pending' ||
        report.gate.verdict === 'pending';
      if (report.verdict === 'not-run' || pending) return 3_000;
      return 20_000;
    },
  });
}

/**
 * Fan-out manual run: enqueues Visual QA for every epic with visual tests.
 * The backend returns per-epic results (jobId on success, skipped reason
 * otherwise). Invalidates the qa-report so the strip repaints immediately.
 */
export function useRunQaReview(planId: string | null) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () =>
      api.post<{
        planId: string;
        results: Array<{ epicId: string; jobId?: string; skipped?: string }>;
      }>(`/plans/${planId}/qa-review`, {}),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['qa-report', planId] });
    },
  });
}

/**
 * Operator sign-off on the AC pillar. Marks every pending criterion as
 * PASS via plan.acApproval. Used when no PO job is available (orchestrator-
 * inline-review world) so the operator can explicitly approve and unblock
 * the Promote-to-Deploy gate.
 */
export function useApproveAc(planId: string | null) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () =>
      api.post<{ planId: string; acApproval: { approvedAt: string; approvedBy: string } }>(
        `/plans/${planId}/approve-ac`,
        {},
      ),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['qa-report', planId] });
      qc.invalidateQueries({ queryKey: ['plans', planId] });
    },
  });
}

/** Revoke an earlier AC sign-off (e.g., after sending a story back). */
export function useRevokeAcApproval(planId: string | null) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api.post<{ planId: string }>(`/plans/${planId}/revoke-ac-approval`, {}),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['qa-report', planId] });
      qc.invalidateQueries({ queryKey: ['plans', planId] });
    },
  });
}

/**
 * Send a story back to Developing with a QA note. Appends the note to the
 * story description, flips status to `fixing`, re-launches the daemon job.
 * Invalidates the QA report + the plan view so both pick up the new state.
 */
export function useSendStoryBack(planId: string | null) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ epicId, storyId, note }: { epicId: string; storyId: string; note: string }) =>
      api.post<{ storyId: string; status: 'fixing'; jobId: string | null; warning?: string }>(
        `/epic-workflows/${epicId}/stories/${storyId}/send-back`,
        { note, source: 'QA Review' },
      ),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['qa-report', planId] });
      qc.invalidateQueries({ queryKey: ['plans', planId] });
      qc.invalidateQueries({ queryKey: ['epic-workflow'] });
    },
  });
}
