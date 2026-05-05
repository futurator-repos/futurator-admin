'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { useApp } from '@/hooks/use-apps';
import { usePlan } from '@/hooks/use-plans';
import { PlanBreadcrumb } from './plan-breadcrumb';
import { PlanActionsBar } from './plan-actions-bar';
import { PlanDashboard } from '@/components/labs/plan-dashboard';
import { links } from '@/lib/links';

/**
 * Plan detail view — mounted by `/labs/page.tsx` when both `?appId=X` and
 * `?planId=Y` are in the URL. Wraps the existing PlanDashboard with the new
 * App-aware breadcrumb and status-driven actions bar.
 */
export function PlanDetailView({ appId, planId }: { appId: string; planId: string }) {
  const router = useRouter();
  const appQ = useApp(appId);
  const planQ = usePlan(planId);

  // Integrity guard: URL appId must match plan.appId. Redirect to canonical URL.
  useEffect(() => {
    if (planQ.data && planQ.data.appId && planQ.data.appId !== appId) {
      router.replace(links.plan(planQ.data.appId, planId));
    }
  }, [planQ.data, appId, planId, router]);

  if (appQ.isLoading || planQ.isLoading) {
    return <div className="p-6 text-muted-foreground">Loading…</div>;
  }
  if (appQ.error) {
    return (
      <div className="rounded-lg border border-destructive/30 bg-destructive/5 p-4 text-sm text-destructive">
        Failed to load App: {(appQ.error as Error).message}
      </div>
    );
  }
  if (planQ.error) {
    return (
      <div className="rounded-lg border border-destructive/30 bg-destructive/5 p-4 text-sm text-destructive">
        Failed to load Plan: {(planQ.error as Error).message}
      </div>
    );
  }

  const app = appQ.data?.app;
  const plan = planQ.data;
  if (!app || !plan) {
    return <div className="p-6 text-muted-foreground">Plan not found.</div>;
  }

  const planIndex = (appQ.data?.plans ?? []).findIndex((p) => p.planId === planId);
  const planNumber = planIndex >= 0 ? planIndex + 1 : 1;

  return (
    <div className="space-y-4">
      <PlanBreadcrumb app={app} plan={plan} planNumber={planNumber} />
      <PlanActionsBar plan={plan} />
      <PlanDashboard planId={planId} />
    </div>
  );
}
