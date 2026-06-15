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
        report.gate.verdict === 'pending' ||
        // Deployment v2.5 — keep polling while the dev preview is building so
        // the "Open in dev" link appears as soon as it goes live.
        report.devPreview?.status === 'deploying';
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

/**
 * B#2 — Accept (or un-accept) a VQA test as a known static-screenshot
 * limitation. An accepted failing test is treated as non-blocking by the
 * aggregator, so the VQA pillar can go green for interaction-gated ACs the
 * headless judge can't verify from one idle frame.
 */
export function useAcceptQaTest(planId: string | null) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ testId, accept }: { testId: string; accept: boolean }) =>
      accept
        ? api.post<{ planId: string; testId: string; qaAcceptedTestIds: string[] }>(
            `/plans/${planId}/qa-tests/${testId}/accept`,
            {},
          )
        : api.delete<{ planId: string; testId: string; qaAcceptedTestIds: string[] }>(
            `/plans/${planId}/qa-tests/${testId}/accept`,
          ),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['qa-report', planId] });
      qc.invalidateQueries({ queryKey: ['plans', planId] });
    },
  });
}

/**
 * B#3 — batch "Send all failing back to dev". Sends every non-accepted failing
 * VQA story back at once (grouped by owning story). Enforces a per-(plan, wave)
 * fix-cycle hard cap server-side; capped waves come back in `capped[]` instead
 * of being re-sent.
 */
export function useSendBackFailing(planId: string | null) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () =>
      api.post<{
        planId: string;
        sentBack: Array<{ storyId: string; jobId: string; failingTests: number }>;
        capped: Array<{ waveNumber: number; storyIds: string[]; attempts: number }>;
        failed: Array<{ storyId: string; reason: string }>;
        cap: number;
      }>(`/plans/${planId}/qa/send-back-failing`, {}),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['qa-report', planId] });
      qc.invalidateQueries({ queryKey: ['plans', planId] });
      qc.invalidateQueries({ queryKey: ['epic-workflow'] });
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
 * PR-8d — operator approves the QA test contract produced by the
 * aggregate stage. Body may carry per-test overrides:
 *
 *   { tests: [{ id, level?, expect?, ... }] }
 *
 * Omitting `tests` means "approve everything the aggregator
 * classified, unchanged." The backend launches qa-execute and flips
 * `plan.qaContractStatus = 'approved'`.
 */
export function useApproveQaContract(planId: string | null) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body?: {
      tests?: Array<{ id: string; level?: 'L0' | 'L1' | 'L2'; expect?: string }>;
    }) =>
      api.post<{
        planId: string;
        jobId: string;
        stage: 'execute';
        testCount: number;
        contractStatus: 'approved';
      }>(`/plans/${planId}/qa-contract/approve`, body ?? {}),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['qa-report', planId] });
      qc.invalidateQueries({ queryKey: ['plans', planId] });
    },
  });
}

/**
 * PR-8d — operator declines to run QA for this plan. The execute
 * stage never launches; `plan.qaContractStatus = 'rejected'`. Reversible
 * — operator can later click Re-classify (which calls `useRunQaReview`)
 * to re-aggregate and get a fresh contract.
 */
export function useRejectQaContract(planId: string | null) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () =>
      api.post<{ planId: string; contractStatus: 'rejected' }>(
        `/plans/${planId}/qa-contract/reject`,
        {},
      ),
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
