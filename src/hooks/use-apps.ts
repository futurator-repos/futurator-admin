'use client';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api-client';
import type { App, AppCardData, CreateAppInput, UpdateAppInput } from '@/types/app';
import type { Plan } from '@/types/plan';

/** App/Plan v1 — Apps grid data. */
export function useApps() {
  return useQuery({
    queryKey: ['apps'],
    queryFn: () => api.get<{ apps: AppCardData[] }>('/apps').then((r) => r.apps),
    staleTime: 5 * 60 * 1000,
  });
}

/** App detail (App + plans + activePlan + recentDeploys). */
export interface AppDetailResponse {
  app: App;
  plans: Plan[];
  activePlan: Plan | null;
  recentDeploys: unknown[];
}

export function useApp(appId: string | null | undefined) {
  return useQuery({
    queryKey: ['app', appId],
    queryFn: () => api.get<AppDetailResponse>(`/apps/${appId}`),
    enabled: !!appId,
    staleTime: 5 * 60 * 1000,
    refetchInterval: (query) => {
      const data = query.state.data;
      if (data?.activePlan?.status === 'developing') return 5_000;
      return false;
    },
    retry: (failureCount, error) => {
      const msg = error instanceof Error ? error.message : String(error);
      if (/\b404\b|not.?found/i.test(msg)) return false;
      return failureCount < 2;
    },
  });
}

/**
 * Story 1.4 — saga response envelope.
 *
 * Pre-1.4 the route returned `{ app }`. The saga now returns
 * `{ app, jobId, repo }` so the UI can poll the bootstrap job and link
 * to the GitHub repo immediately. Both shapes are tolerated for the
 * migration window.
 */
export function useCreateApp() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateAppInput) =>
      api
        .post<{
          app: App;
          jobId?: string;
          repo?: { htmlUrl?: string; defaultBranch?: string } | null;
        }>('/apps', input)
        .then((r) => r.app),
    onSuccess: (newApp) => {
      qc.invalidateQueries({ queryKey: ['apps'] });
      qc.setQueryData(['app', newApp.appId], {
        app: newApp,
        plans: [],
        activePlan: null,
        recentDeploys: [],
      });
    },
  });
}

export function useUpdateApp(appId: string | null | undefined) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (patch: UpdateAppInput) =>
      api.patch<{ app: App }>(`/apps/${appId}`, patch).then((r) => r.app),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['app', appId] });
      qc.invalidateQueries({ queryKey: ['apps'] });
    },
  });
}

export function useDeleteApp(appId: string | null | undefined) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api.delete<void>(`/apps/${appId}`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['apps'] });
      qc.removeQueries({ queryKey: ['app', appId] });
    },
  });
}

export interface CreatePlanForAppInput {
  kind: 'initial' | 'change' | 'experiment';
  intent: string;
  executionMode?: 'pipeline' | 'orchestrator';
  displayName?: string;
  rigor?: 'prototype' | 'mvp' | 'production';
  /** PR-10 #1 — optional plan slug. Auto-generated server-side if omitted. */
  name?: string;
}

export function useCreatePlanForApp(appId: string | null | undefined) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: CreatePlanForAppInput) =>
      // Server returns { plan, pmJobId } for kind=initial — caller needs pmJobId
      // to navigate to /labs?planId=X&pmJobId=Y so PlanDashboard auto-polls +
      // auto-applies the PM output. Without pmJobId on the URL, the plan
      // opens stuck in 'concept' status with the operator-confusing
      // "Regenerate" button as the only forward path.
      api.post<{ plan: Plan; pmJobId?: string }>(`/apps/${appId}/plans`, input),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['app', appId] });
      qc.invalidateQueries({ queryKey: ['apps'] });
    },
  });
}

export function useRedeployApp(appId: string | null | undefined) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (deployJobId: string) =>
      api.post<{ status: string; appId: string; sourceDeployJobId: string }>(
        `/apps/${appId}/redeploy`,
        { deployJobId },
      ),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['app', appId] });
    },
  });
}

export function useTransitionPlan(planId: string | null | undefined) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (to: Plan['status']) =>
      api.post<{ plan: Plan }>(`/plans/${planId}/transition`, { to }).then((r) => r.plan),
    onSuccess: (plan) => {
      qc.invalidateQueries({ queryKey: ['plans', planId] });
      if (plan.appId) {
        qc.invalidateQueries({ queryKey: ['app', plan.appId] });
        qc.invalidateQueries({ queryKey: ['apps'] });
      }
    },
  });
}
