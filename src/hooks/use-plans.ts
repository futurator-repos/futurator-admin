'use client';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api-client';
import type { Plan, PlanSummary, PlanCreateInput } from '@/types/plan';
import type { EpicWorkflow } from '@/types/epic-workflow';

/** Full plan (incl. hydrated epics) returned by GET /api/plans/:id. */
export interface PlanWithEpics extends Plan {
  epics?: EpicWorkflow[];
}

export function usePlansList() {
  return useQuery({
    queryKey: ['plans'],
    queryFn: () => api.get<PlanSummary[]>('/plans'),
    staleTime: 5_000,
    refetchInterval: (query) => {
      const plans = query.state.data;
      if (!plans) return 10_000;
      const anyActive = plans.some(
        (p) => p.status === 'developing' || p.status === 'fixing' || p.status === 'concept',
      );
      return anyActive ? 5_000 : 20_000;
    },
  });
}

export function usePlan(planId: string | null) {
  return useQuery({
    queryKey: ['plans', planId],
    queryFn: () => api.get<PlanWithEpics>(`/plans/${planId}`),
    enabled: !!planId,
    // Stop retrying a bogus / deleted planId — `UUID-…` style corrupted URLs
    // (ellipsis paste) used to loop forever here and flood the console with
    // /api/plans/<bad-id> 404s. Match on message OR on the (http-client-
    // specific) status code — the api-client may surface either depending
    // on how the response was parsed.
    retry: (failureCount, error) => {
      const msg = error instanceof Error ? error.message : String(error);
      if (/\b404\b|not.?found/i.test(msg)) return false;
      return failureCount < 2;
    },
    refetchInterval: (query) => {
      // Don't poll a broken query (404/network error) — the error state
      // holds and the dashboard renders its "plan not found" surface.
      if (query.state.error) return false;
      const plan = query.state.data;
      if (!plan) return 3_000;
      if (plan.status === 'developing' || plan.status === 'fixing') return 3_000;
      return 20_000;
    },
  });
}

/**
 * Labs3 fast path — intent → a running Pipeline-3 plan (no concept chain).
 * Scaffolds a fresh app + a quick-planspec generation job. Returns the new planId.
 */
export function useQuickP3Plan() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: { intent: string; name?: string }) =>
      api.post<{ planId: string; appId: string; jobId: string }>('/plans/quick-p3', input),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['plans'] });
    },
  });
}

export function useCreatePlanFromIntent() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: PlanCreateInput) =>
      api.post<{ planId: string; pmJobId: string; plan: Plan }>('/plans/from-intent', input),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['plans'] });
    },
  });
}

/**
 * Create an empty plan + install BMAD on its folder, with no PM job.
 * Two-step: POST /plans (DDB row + folder + plan.md) → POST /plans/:id/bmad/install
 * (party-bootstrap job that runs `npx bmad-method install`). Returns the plan
 * and the bootstrap jobId so the UI can navigate + surface install progress.
 */
export function useCreateEmptyBmadPlan() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: PlanCreateInput) => {
      const { plan } = await api.post<{ plan: Plan }>('/plans', input);
      const { bmadJobId } = await api.post<{
        planId: string;
        bmadJobId?: string;
        inProgress: boolean;
      }>(`/plans/${plan.planId}/bmad/install`, {});
      return { plan, bmadJobId };
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['plans'] });
    },
  });
}

export function useApplyPlanOutput(planId: string | null) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ jobId }: { jobId?: string } = {}) =>
      api.post<{ plan: Plan; epics: EpicWorkflow[] }>(
        jobId ? `/plans/${planId}/apply-plan?jobId=${jobId}` : `/plans/${planId}/apply-plan`,
        {},
      ),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['plans', planId] });
      queryClient.invalidateQueries({ queryKey: ['plans'] });
    },
  });
}

/**
 * Concept v2 — apply the Concept Router's completed output to the plan row.
 * The endpoint auto-discovers the plan's `conceptRouteJobId` (or the most
 * recent COMPLETED concept-route job), validates CONCEPT_PLAN_JSON, and
 * persists `plan.conceptPlan`. Driven from the dashboard once the route job
 * COMPLETEs (mirrors the apply-plan auto-trigger).
 */
export function useApplyConceptPlan(planId: string | null) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () =>
      api.post<{ planId: string; conceptPlan: unknown }>(`/plans/${planId}/apply-concept-plan`, {}),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['plans', planId] });
      queryClient.invalidateQueries({ queryKey: ['plans'] });
    },
  });
}

export function useRegeneratePlan(planId: string | null) {
  return useMutation({
    mutationFn: () =>
      api.post<{ planId: string; pmJobId: string }>(`/plans/${planId}/regenerate`, {}),
  });
}

export function useStartPlan(planId: string | null) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () =>
      api.post<{ planId: string; jobsByEpic: Record<string, string[]>; waveNumber: number }>(
        `/plans/${planId}/start`,
        {},
      ),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['plans', planId] });
      queryClient.invalidateQueries({ queryKey: ['plans'] });
    },
  });
}

// ── Concept-stage plan portability (2026-06-11) ──
// Export the epic tree as PM-output JSON, import an edited/externally-
// generated plan JSON, and fetch the PM prompt for external-LLM handoff.

export interface PlanExport {
  schema: string;
  exportedAt: string;
  planId: string;
  intent: string;
  rigor: string | null;
  status: string;
  plan: {
    name: string;
    description: string;
    epics: unknown[];
  };
}

export function useExportPlan(planId: string | null) {
  return useMutation({
    mutationFn: () => api.get<PlanExport>(`/plans/${planId}/export`),
  });
}

export function usePmPrompt(planId: string | null) {
  return useMutation({
    mutationFn: () =>
      api.get<{ planId: string; boilerplateType: string; prompt: string; note: string }>(
        `/plans/${planId}/pm-prompt`,
      ),
  });
}

export function useImportPlan(planId: string | null) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (planJson: string) =>
      api.post<{ plan: Plan; epics: EpicWorkflow[] }>(`/plans/${planId}/import-plan`, {
        planJson,
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['plans', planId] });
      queryClient.invalidateQueries({ queryKey: ['plans'] });
    },
  });
}

export function usePatchPlan(planId: string | null) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (patch: Partial<Plan>) => api.patch<{ plan: Plan }>(`/plans/${planId}`, patch),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['plans', planId] });
      queryClient.invalidateQueries({ queryKey: ['plans'] });
    },
  });
}

// ── Archive/restore/delete — stubbed hooks for 17.7 to fill in. ──
export function useArchivePlan(planId: string | null) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => api.post<{ plan: Plan }>(`/plans/${planId}/archive`, {}),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['plans'] }),
  });
}

export function useRestorePlan(planId: string | null) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => api.post<{ plan: Plan }>(`/plans/${planId}/restore`, {}),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['plans'] }),
  });
}

export function useDeletePlan(planId: string | null) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => api.delete<{ planId: string; results: unknown[] }>(`/plans/${planId}`),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['plans'] }),
  });
}
