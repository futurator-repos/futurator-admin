'use client';
import { Suspense } from 'react';
import { useSearchParams } from 'next/navigation';
import { AppShell } from '@/components/layout/app-shell';
import { AuthGuard } from '@/components/auth/auth-guard';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { ClaudeCodeWorkflow } from '@/components/labs/claude-code-workflow';
import { Party } from '@/components/labs/party';
import { RuntimeControls } from '@/components/labs/runtime-controls';
import { PlanDashboard } from '@/components/labs/plan-dashboard';
import { AppsGrid } from '@/components/labs/apps/apps-grid';
import { AppDetailView } from '@/components/labs/app-detail/app-detail-view';
import { PlanDetailView } from '@/components/labs/app-detail/plan-detail-view';

function LabsContent() {
  const params = useSearchParams();
  const appId = params.get('appId');
  const planId = params.get('planId');

  // App/Plan v1 — App-aware nested view. Static-export-compatible: dynamic
  // segments are encoded as query params, not path params.
  //   /labs?appId=dino3&planId=p1  → Plan detail (App + breadcrumb shell)
  //   /labs?appId=dino3            → App detail (timeline, banners, deploys)
  //   /labs?planId=p1              → legacy: Plan dashboard without App context
  //   /labs                        → Apps grid + Plans/Party tabs
  if (appId && planId) {
    return <PlanDetailView appId={appId} planId={planId} />;
  }
  if (appId) {
    return <AppDetailView appId={appId} />;
  }
  if (planId) {
    // Legacy fallback for any direct ?planId= links pre-App/Plan v1.
    return <PlanDashboard planId={planId} />;
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-4">
        <h1 className="text-page-title">Labs</h1>
        <RuntimeControls />
      </div>

      <Tabs defaultValue="apps">
        <TabsList variant="line">
          <TabsTrigger value="apps">Apps</TabsTrigger>
          <TabsTrigger value="claude-code-workflow">Claude Code Pipeline</TabsTrigger>
          <TabsTrigger value="party">Party</TabsTrigger>
        </TabsList>
        <TabsContent value="apps">
          <AppsGrid />
        </TabsContent>
        <TabsContent value="claude-code-workflow">
          <ClaudeCodeWorkflow />
        </TabsContent>
        <TabsContent value="party">
          <Party />
        </TabsContent>
      </Tabs>
    </div>
  );
}

export default function LabsPage() {
  return (
    <AuthGuard>
      <AppShell>
        <Suspense fallback={<div className="p-6 text-sm text-muted-foreground">Loading…</div>}>
          <LabsContent />
        </Suspense>
      </AppShell>
    </AuthGuard>
  );
}
