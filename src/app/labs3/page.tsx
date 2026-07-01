'use client';
import { Suspense } from 'react';
import { useSearchParams } from 'next/navigation';
import { AppShell } from '@/components/layout/app-shell';
import { AuthGuard } from '@/components/auth/auth-guard';
import { PlanSpecDashboard } from '@/components/labs3/plan-spec-dashboard';
import { Labs3Launcher } from '@/components/labs3/launcher';

/**
 * Labs3 — the pipeline-3 / SDD visualization surface. A NEW sibling of legacy
 * Labs that reads the plan-spec-graph (StoryNode topology) instead of the
 * epic→wave plan model. Legacy Labs is untouched.
 *
 * Static-export friendly: the plan id is a query param, never a path segment.
 *   /labs3?planId=<uuid>   → the plan's spec-graph dashboard
 *   /labs3                 → guidance to pick a plan (via legacy Labs)
 */
function Labs3Content() {
  const params = useSearchParams();
  const planId = params.get('planId');

  if (planId) {
    return <PlanSpecDashboard planId={planId} />;
  }

  return <Labs3Launcher />;
}

export default function Labs3Page() {
  return (
    <AuthGuard>
      <AppShell>
        <Suspense fallback={<div className="p-6 text-sm text-muted-foreground">Loading…</div>}>
          <Labs3Content />
        </Suspense>
      </AppShell>
    </AuthGuard>
  );
}
