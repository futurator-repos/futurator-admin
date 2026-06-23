'use client';

/**
 * Refactoring Assessment Module hooks (Epic D, FR31).
 *
 *   useRunAppAudit(appId)   — POST /party/projects/:appId/assess → { jobId }.
 *   useAppAuditJob(jobId)   — poll the audit job; self-terminates on terminal.
 *   selectAuditReport(job)  — derive the dashboard view from a polled job row.
 *
 * MVP transport (the cheap/fast path): there is no durable audit table yet
 * (that's Epic C). The recon writes `hotspots.json` to the EC2 clone disk, which
 * the API Lambda can't read — so the daemon denormalizes the full hotspot array
 * onto the no-TTL `futurator-agent-jobs` row (`refactorAuditSummary.hotspots`),
 * and the dashboard reads it by polling `GET /agent-jobs/:id`. The producing
 * `jobId` is stashed in the URL (`?auditJob=…`) so a reload resumes the view.
 *
 * NOTE: the api-client base URL already ends in `/api` (MEMORY:
 * project_api_client_path_convention) — do NOT prefix paths with `/api`.
 */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api-client';
import { useAgentJob } from '@/hooks/use-agent-job';
import type { AgentJob } from '@/types/agent-orchestrator';
import type { AuditHotspot, HotspotKind, RefactorAuditRecord } from '@/types/refactor-audit';

/** Optional knobs the operator can pass when starting an audit. */
export interface RunAppAuditInput {
  src?: string;
  skipGraphify?: boolean;
  runL3?: boolean;
  topN?: number;
}

interface RunAppAuditResponse {
  jobId: string;
  projectId: string;
}

/**
 * Start a refactoring assessment for a (migrated brownfield) app. Returns the
 * enqueued `{ jobId, projectId }`; the caller stashes `jobId` and polls it via
 * `useAppAuditJob`. `:appId` IS the project id.
 */
export function useRunAppAudit(appId: string | null) {
  return useMutation({
    mutationFn: (input: RunAppAuditInput = {}) =>
      api.post<RunAppAuditResponse>(`/party/projects/${appId}/assess`, input),
  });
}

/**
 * Poll an audit job. Thin wrapper over `useAgentJob` (whose `refetchInterval`
 * self-terminates on COMPLETED/FAILED/error — no infinite 404 loop, NFR7).
 */
export function useAppAuditJob(jobId: string | null) {
  return useAgentJob(jobId);
}

/** The dashboard's derived view of an audit job. */
export type AuditReport =
  | { status: 'idle' }
  | { status: 'assessing'; jobId: string }
  | {
      status: 'scored';
      jobId: string;
      hotspots: AuditHotspot[];
      counts: Partial<Record<HotspotKind, number>>;
      hotspotCount: number;
      reportPath: string | null;
    }
  | { status: 'failed'; jobId: string; message: string };

/**
 * Derive the dashboard view from a polled job row. Pure — unit-testable, and
 * keeps the source of hotspots in ONE place so Epic C can later swap the job
 * row for the durable table without touching the UI.
 */
export function selectAuditReport(job: AgentJob | undefined | null): AuditReport {
  if (!job) return { status: 'idle' };
  const jobId = job.jobId;
  if (job.status === 'FAILED') {
    return { status: 'failed', jobId, message: job.errorMessage || 'Assessment failed' };
  }
  if (job.status === 'COMPLETED') {
    const s = job.refactorAuditSummary;
    return {
      status: 'scored',
      jobId,
      hotspots: s?.hotspots ?? [],
      counts: s?.counts ?? {},
      hotspotCount: s?.hotspotCount ?? s?.hotspots?.length ?? 0,
      reportPath: s?.reportPath ?? null,
    };
  }
  // PENDING / RUNNING
  return { status: 'assessing', jobId };
}

// ── Durable persistence (CRUD) — assessments survive across machines/sessions ──
// The recon report rides the no-TTL job row during/after a run; but a fresh
// browser (another computer, no ?auditJob in the URL) has no job to read. The
// daemon also writes every completed audit to the durable futurator-refactor-audits
// table, so these hooks let the UI load past assessments anywhere.

const QK_AUDITS = (appId: string) => ['app-audits', appId] as const;

/** List a project's durable audits, newest-first (§9.4). */
export function useAppAudits(appId: string | null) {
  return useQuery({
    queryKey: QK_AUDITS(appId ?? ''),
    queryFn: () => api.get<{ audits: RefactorAuditRecord[] }>(`/party/projects/${appId}/audits`),
    enabled: !!appId,
    staleTime: 60_000,
  });
}

/** Fetch one durable audit record by id (§9.5) — its hotspots + verdicts + plan. */
export function useAuditRecord(auditId: string | null) {
  return useQuery({
    queryKey: ['audit-record', auditId],
    queryFn: () => api.get<RefactorAuditRecord>(`/refactor-audits/${auditId}`),
    enabled: !!auditId,
    staleTime: 5 * 60_000,
  });
}

/** Delete a durable audit (CRUD). Invalidates the app's audit list on success. */
export function useDeleteAudit(appId: string | null) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (auditId: string) => api.delete<{ deleted: string }>(`/refactor-audits/${auditId}`),
    onSuccess: () => {
      if (appId) qc.invalidateQueries({ queryKey: QK_AUDITS(appId) });
    },
  });
}

/** Derive the dashboard view from a durable audit record (cross-machine load). */
export function reportFromRecord(rec: RefactorAuditRecord | undefined | null): AuditReport {
  if (!rec) return { status: 'idle' };
  return {
    status: 'scored',
    jobId: rec.jobId,
    hotspots: rec.hotspots ?? [],
    counts: rec.counts ?? {},
    hotspotCount: rec.hotspots?.length ?? 0,
    reportPath: null,
  };
}
