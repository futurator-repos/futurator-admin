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
import type { AgenticReport } from '@/components/labs3/views/qa/agentic-journeys-section';

// Q2 — the client mirror (src/types/qa-review-p3.ts) does not yet carry
// `P3QaReport.agentic` (backend: functions/shared/types/qa-review-p3.ts:
// 130-161). Widened locally rather than editing the foreign mirror file —
// see build slice deviations. Drop once the mirror syncs.
export type P3QaReportWithAgentic = P3QaReport & { agentic?: AgenticReport };

const QK_P3_QA = (planId: string) => ['p3-qa-report', planId] as const;

/**
 * Client rollout flag for the W2 view. Mirrors the other build-time
 * `NEXT_PUBLIC_*` flags read directly off `process.env` (sidebar.tsx reads
 * `NEXT_PUBLIC_BUILD_HASH`/`NEXT_PUBLIC_BUILD_TIME` the same way — no central
 * flag registry exists in this repo yet). Defaults ENABLED — only an explicit
 * `'false'` opts out — so an unset env (every local dev shell today) doesn't
 * silently hide the tab once a report exists.
 *
 * This client default (enabled) intentionally AGREES with the server default,
 * which is durable-on in sst.config.ts (`P3_QA_REVIEW ?? 'on'`). Neither side
 * can silently dark-ship the deployed-app QA gate.
 */
export function isP3QaReviewFlagEnabled(): boolean {
  return process.env.NEXT_PUBLIC_P3_QA_REVIEW !== 'false';
}

// ── Readiness rule (FROZEN CONTRACT single source of truth) ───────────

/**
 * The minimal plan-ish shape the readiness rule needs. Both `Plan`
 * (src/types/plan.ts) and a report+verdict pair coerce to this.
 */
export interface DeliverabilityInput {
  /** Set when a non-blocking verdict is durable for the current qaCommitSha. */
  qaVerifiedAt?: string;
  /** The operator/QA verdict — carries `decision` and `blocking`. */
  p3QaVerdict?: Partial<Pick<P3QaVerdict, 'decision' | 'blocking'>> | null;
}

/**
 * The tri-state the UI renders from. `verified` ⇒ green "ready to deliver";
 * `blocking` ⇒ red "QA blocking"; `pending` ⇒ neutral "QA pending/unverified"
 * (NEVER green off a unit-AC rollup alone).
 */
export type QaReadiness = 'verified' | 'blocking' | 'pending';

/**
 * The SINGLE source of truth for "is this plan deliverable?" — verbatim the
 * FROZEN CONTRACT readiness rule:
 *   isDeliverable === Boolean(qaVerifiedAt) || p3QaVerdict?.decision === 'approved'
 */
export function isDeliverable(input: DeliverabilityInput): boolean {
  return Boolean(input.qaVerifiedAt) || input.p3QaVerdict?.decision === 'approved';
}

/**
 * Map a plan-ish input to the readiness tri-state the UI paints:
 *   deliverable                              → 'verified' (green, ready)
 *   not deliverable + a blocking verdict     → 'blocking' (red)
 *   not deliverable + no verdict / non-block → 'pending'  (neutral, NOT green)
 */
export function qaReadiness(input: DeliverabilityInput): QaReadiness {
  if (isDeliverable(input)) return 'verified';
  if (input.p3QaVerdict?.blocking) return 'blocking';
  return 'pending';
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
function coerceP3QaReport(raw: unknown): P3QaReportWithAgentic | null {
  try {
    if (!raw || typeof raw !== 'object') return null;
    const r = raw as Partial<P3QaReportWithAgentic>;
    if (typeof r.planId !== 'string' || typeof r.status !== 'string') return null;
    return {
      planId: r.planId,
      qaCommitSha: typeof r.qaCommitSha === 'string' ? r.qaCommitSha : '',
      devUrl: typeof r.devUrl === 'string' ? r.devUrl : '',
      status: r.status as P3QaStatus,
      journeys: Array.isArray(r.journeys) ? r.journeys : [],
      vqa: Array.isArray(r.vqa) ? r.vqa : [],
      wiring: r.wiring ?? { orphanModules: [], blocking: false },
      // Passthrough of plan.qaVerifiedAt (the endpoint stamps it on the report
      // envelope). Drives the readiness rule; absent ⇒ QA has NOT passed.
      qaVerifiedAt: typeof r.qaVerifiedAt === 'string' ? r.qaVerifiedAt : undefined,
      // Q2 — passthrough of the agentic (BrowserAgent) lane report. ABSENT
      // when the lane didn't run (flag off / no delivery journeys) — never
      // synthesized here, so AgenticJourneysSection can key its render purely
      // on presence.
      agentic:
        r.agentic && typeof r.agentic === 'object' && Array.isArray(r.agentic.runs)
          ? r.agentic
          : undefined,
    };
  } catch {
    // Parsing itself blew up (unexpected nested shape) — never throw into the tab.
    return null;
  }
}

export interface UseP3QaReportResult {
  /** False when the client flag is off — the view should fall back to legacy QA. */
  enabled: boolean;
  report: P3QaReportWithAgentic | null;
  /**
   * The full verdict from the GET envelope (`{ enabled, report, verdict }`).
   * Carries `decision` + `blocking` — the readiness rule's `approved`/`blocking`
   * inputs, which the display-shaped `report` does not encode. `null` until a
   * verdict exists.
   */
  verdict: P3QaVerdict | null;
  isLoading: boolean;
  isError: boolean;
  error: Error | null;
  refetch: () => void;
}

/** Internal query payload — keeps report + verdict together for the cache. */
interface P3QaEnvelope {
  report: P3QaReportWithAgentic | null;
  verdict: P3QaVerdict | null;
}

/** Light guard: a verdict is usable only if it has a `status` string. */
function coerceP3QaVerdict(raw: unknown): P3QaVerdict | null {
  if (!raw || typeof raw !== 'object') return null;
  const v = raw as Partial<P3QaVerdict>;
  if (typeof v.status !== 'string') return null;
  return v as P3QaVerdict;
}

/**
 * Fetch the plan-level QA-Review W2 report. Polls fast while a QA run is
 * in-flight (`status === 'running'`); otherwise sits idle — the operator (or
 * an auto-trigger elsewhere) starts the next run explicitly.
 */
export function useP3QaReport(planId: string | null): UseP3QaReportResult {
  const flagEnabled = isP3QaReviewFlagEnabled();
  const query = useQuery<P3QaEnvelope>({
    queryKey: QK_P3_QA(planId ?? ''),
    queryFn: async () => {
      try {
        // The endpoint returns an envelope { enabled, report, verdict } — the
        // report is nested. Coercing the whole envelope always yields null
        // (no top-level planId/status), so the view never rendered. Unwrap it,
        // keeping the verdict alongside (it carries decision/blocking that the
        // display-shaped report does not — the readiness rule needs them).
        const raw = await api.get<{ enabled?: boolean; report?: unknown; verdict?: unknown }>(
          `/plans/${planId}/qa-review-p3`,
        );
        if (raw && raw.enabled === false) return { report: null, verdict: null };
        return {
          report: coerceP3QaReport(raw?.report),
          verdict: coerceP3QaVerdict(raw?.verdict),
        };
      } catch {
        // A malformed/absent report is a data state (render "no report yet"),
        // never an uncaught exception into the tab.
        return { report: null, verdict: null };
      }
    },
    enabled: !!planId && flagEnabled,
    staleTime: 3_000,
    refetchInterval: (q) => computeP3QaRefetchInterval(q.state.data?.report?.status),
  });

  if (!flagEnabled) {
    return {
      enabled: false,
      report: null,
      verdict: null,
      isLoading: false,
      isError: false,
      error: null,
      refetch: () => {},
    };
  }

  return {
    enabled: true,
    report: query.data?.report ?? null,
    verdict: query.data?.verdict ?? null,
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

export interface RunAgenticQaInput {
  /** 'auto' prefers the operator's live Chrome extension, falls back to headless fleet. */
  mode: 'auto' | 'headless' | 'extension';
}

export interface RunAgenticQaResponse {
  planId: string;
  queued: boolean;
}

/**
 * Slice B — operator-facing trigger for an AGENTIC-ONLY visual-QA run against
 * the plan's dev deploy. Deliberately narrow: it does NOT re-run the full
 * deterministic QA lane (journeys/wiring/VQA) and does NOT touch the
 * SHA-guarded P3QaVerdict — it only enqueues a fresh `report.agentic` run.
 * POST /plans/:id/qa/agentic-run — additive-only route, sibling to (not a
 * replacement for) the QA-Review W2 endpoints above.
 *
 * On success, invalidates the report query so the existing poll (which
 * speeds up while `report.status === 'running'`) picks up the new run once
 * the daemon appends it to `report.agentic.runs`.
 */
export function useRunAgenticQa(planId: string | null) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: RunAgenticQaInput) =>
      api.post<RunAgenticQaResponse>(`/plans/${planId}/qa/agentic-run`, input),
    onSuccess: () => {
      if (planId) qc.invalidateQueries({ queryKey: QK_P3_QA(planId) });
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
