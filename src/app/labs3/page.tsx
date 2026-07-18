'use client';
import { Suspense, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { AppShell } from '@/components/layout/app-shell';
import { AuthGuard } from '@/components/auth/auth-guard';
import { PlanSpecDashboard } from '@/components/labs3/plan-spec-dashboard';
import { Labs3Launcher } from '@/components/labs3/launcher';
import { AppDetailView } from '@/components/labs/app-detail/app-detail-view';
import { AppsGrid } from '@/components/labs/apps/apps-grid';
import { links3 } from '@/lib/links3';

/**
 * Labs3 — the pipeline-3 / SDD visualization surface. A NEW sibling of legacy
 * Labs that reads the plan-spec-graph (StoryNode topology) instead of the
 * epic→wave plan model. Legacy Labs is untouched.
 *
 * Static-export friendly: app/plan ids are query params, never path segments.
 *   /labs3?planId=<uuid>            → the plan's spec-graph dashboard
 *   /labs3?appId=<id>               → app-centric detail (REUSED legacy AppDetailView)
 *   /labs3                          → apps grid home (REUSED legacy AppsGrid), with a
 *                                      "+ New Plan / Quick Create" entry point into
 *                                      Labs3Launcher's quick-create flow.
 */
function Labs3Content() {
  const params = useSearchParams();
  const planId = params.get('planId');
  const appId = params.get('appId');

  if (planId) {
    return <PlanSpecDashboard planId={planId} />;
  }

  if (appId) {
    return (
      <AppDetailView appId={appId} planHref={(_appId, targetPlanId) => links3.plan(targetPlanId)} />
    );
  }

  return <Labs3Home />;
}

/** Apps-grid home (Story U1) — the default `/labs3` landing surface. */
function Labs3Home() {
  const [quickCreateOpen, setQuickCreateOpen] = useState(false);

  if (quickCreateOpen) {
    return (
      <div className="p-6">
        <button
          type="button"
          onClick={() => setQuickCreateOpen(false)}
          className="mb-4 text-xs text-accent-blue hover:underline"
        >
          ← Back to Apps
        </button>
        <Labs3Launcher />
      </div>
    );
  }

  return (
    <div className="p-6">
      <div className="mb-6 flex items-center justify-between">
        <h1 className="text-lg font-semibold tracking-wide">Labs · 3</h1>
        <button
          type="button"
          onClick={() => setQuickCreateOpen(true)}
          className="rounded-md border border-accent-blue px-3 py-1.5 text-xs font-medium text-accent-blue hover:bg-accent-blue/10"
        >
          + New Plan / Quick Create
        </button>
      </div>
      <AppsGrid appHref={links3.app} />
    </div>
  );
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
