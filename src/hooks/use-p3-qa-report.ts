'use client';

/**
 * QA Review W2 — plan-keyed hooks for the ASSEMBLED-app verdict.
 *
 *   useP3QaReport(planId)   — GET /plans/:id/qa-review-p3, fast-polls while running.
 *   useApproveP3Qa(planId)  — POST /plans/:id/qa/approve.
 *   useSendBackP3Qa(planId) — POST /plans/:id/qa/send-back.
 *
 * Plan-keyed, NOT the legacy epic path (`/epic-workflows/:id/stories/:id/send-back`
 * in use-qa-report.ts) — W2 evaluates the assembled app at plan.devUrl, not a
 * single epic's stories. See src/types/qa-review-p3.ts for the report shape.
 *
 * NOTE: the api-client base URL already ends in `/api` (MEMORY:
 * project_api_client_path_convention) — do NOT prefix paths with `/api`.
 */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api-client';
import type { P3QaReport, P3QaStatus, P3QaVerdict } from '@/types/qa-review-p3';

const QK_P3_QA = (planId: string) => ['p3-qa-report', planId] as const;

/**
 * Client rollout flag for the W2 view. Mirrors the other build-time
 * `NEXT_PUBLIC_*` flags read directly off `process.env` (sidebar.tsx reads
 * `NEXT_PUBLIC_BUILD_HASH`/`NEXT_PUBLIC_BUILD_TIME` the same way — no central
 * flag registry exists in this repo yet). Defaults ENABLED — only an explicit
 * `'false'` opts out — so an unset env (every local dev shell today) doesn't
 * silently hide the tab once a report exists.
 */
export function isP3QaReviewFlagEnabled(): boolean {
  return process.env.NEXT_PUBLIC_P3_QA_REVIEW !== 'false';
}

/**
 * Pure poll-interval policy: fast (3s) while the daemon is actively running
 * QA against the assembled app, otherwise idle (no polling — the operator
 * triggers a fresh run explicitly). Exported for unit testing.
 */
export function computeP3QaRefetchInterval(status: P3QaStatus | undefined): number | false {
  return status === 'running' ? 3_000 : false;
}

/**
 * Defensively validate + coerce a raw response into a P3QaReport, or `null`
 * if the shape is unusable. Guards the tab against a partially-written or
 * malformed report row — this must NEVER throw into the caller.
 */
function coerceP3QaReport(raw: unknown): P3QaReport | null {
  try {
    if (!raw || typeof raw !== 'object') return null;
    const r = raw as Partial<P3QaReport>;
    if (typeof r.planId !== 'string' || typeof r.status !== 'string') return null;
    return {
      planId: r.planId,
      qaCommitSha: typeof r.qaCommitSha === 'string' ? r.qaCommitSha : '',
      devUrl: typeof r.devUrl === 'string' ? r.devUrl : '',
      status: r.status as P3QaStatus,
      journeys: Array.isArray(r.journeys) ? r.journeys : [],
      vqa: Array.isArray(r.vqa) ? r.vqa : [],
      wiring: r.wiring ?? { orphanModules: [], blocking: false },
    };
  } catch {
    // Parsing itself blew up (unexpected nested shape) — never throw into the tab.
    return null;
  }
}

export interface UseP3QaReportResult {
  /** False when the client flag is off — the view should fall back to legacy QA. */
  enabled: boolean;
  report: P3QaReport | null;
  isLoading: boolean;
  isError: boolean;
  error: Error | null;
  refetch: () => void;
}

/**
 * Fetch the plan-level QA-Review W2 report. Polls fast while a QA run is
 * in-flight (`status === 'running'`); otherwise sits idle — the operator (or
 * an auto-trigger elsewhere) starts the next run explicitly.
 */
export function useP3QaReport(planId: string | null): UseP3QaReportResult {
  const flagEnabled = isP3QaReviewFlagEnabled();
  const query = useQuery({
    queryKey: QK_P3_QA(planId ?? ''),
    queryFn: async () => {
      try {
        // The endpoint returns an envelope { enabled, report, verdict } — the
        // report is nested. Coercing the whole envelope always yields null
        // (no top-level planId/status), so the view never rendered. Unwrap it.
        const raw = await api.get<{ enabled?: boolean; report?: unknown }>(
          `/plans/${planId}/qa-review-p3`,
        );
        if (raw && raw.enabled === false) return null;
        return coerceP3QaReport(raw?.report);
      } catch {
        // A malformed/absent report is a data state (render "no report yet"),
        // never an uncaught exception into the tab.
        return null;
      }
    },
    enabled: !!planId && flagEnabled,
    staleTime: 3_000,
    refetchInterval: (q) => computeP3QaRefetchInterval(q.state.data?.status),
  });

  if (!flagEnabled) {
    return {
      enabled: false,
      report: null,
      isLoading: false,
      isError: false,
      error: null,
      refetch: () => {},
    };
  }

  return {
    enabled: true,
    report: query.data ?? null,
    isLoading: query.isLoading,
    isError: query.isError,
    error: query.error as Error | null,
    refetch: () => void query.refetch(),
  };
}

export interface ApproveP3QaResponse {
  planId: string;
  verdict: P3QaVerdict;
}

/**
 * Operator approves the W2 verdict — blesses `qaCommitSha` so W3 promotes
 * exactly that commit. Never clobbers a prior decision server-side; this is
 * just the plan-keyed POST.
 */
export function useApproveP3Qa(planId: string | null) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api.post<ApproveP3QaResponse>(`/plans/${planId}/qa/approve`, {}),
    onSuccess: () => {
      if (planId) qc.invalidateQueries({ queryKey: QK_P3_QA(planId) });
      qc.invalidateQueries({ queryKey: ['plans', planId] });
    },
  });
}

export interface SendBackP3QaInput {
  note?: string;
}

export interface SendBackP3QaResponse {
  planId: string;
  verdict: P3QaVerdict;
}

/**
 * Operator sends the assembled app back to dev with an optional note. Plan-
 * keyed (`/plans/:id/qa/send-back`) — NOT the legacy per-story epic path.
 */
export function useSendBackP3Qa(planId: string | null) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: SendBackP3QaInput = {}) =>
      api.post<SendBackP3QaResponse>(`/plans/${planId}/qa/send-back`, input),
    onSuccess: () => {
      if (planId) qc.invalidateQueries({ queryKey: QK_P3_QA(planId) });
      qc.invalidateQueries({ queryKey: ['plans', planId] });
    },
  });
}

/**
 * W3-lite — plan-keyed promote up the ladder. `to: 'staging'` requires an
 * APPROVED QA verdict server-side (the Approve above is the gate);
 * `to: 'production'` requires a staging artifact. Body/route mirror the legacy
 * ladder but resolve identity from plan.appId (no epics).
 */
export function usePromoteP3(planId: string | null) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (args: { to: 'staging' | 'production' }) =>
      api.post<{ jobId: string; to: string; publicUrl: string }>(`/plans/${planId}/promote`, args),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['p3-qa-report', planId] });
      qc.invalidateQueries({ queryKey: ['plans', planId] });
    },
  });
}
