'use client';
import { Suspense } from 'react';
import { useSearchParams } from 'next/navigation';
import { AppShell } from '@/components/layout/app-shell';
import { AuthGuard } from '@/components/auth/auth-guard';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { ClaudeCodeWorkflow } from '@/components/labs/claude-code-workflow';
import { Party } from '@/components/labs/party';
import { RuntimeControls } from '@/components/labs/runtime-controls';
import { PlansList } from '@/components/labs/plans/plans-list';
import { PlanDashboard } from '@/components/labs/plan-dashboard';

function LabsContent() {
  const params = useSearchParams();
  const planId = params.get('planId');

  // When a plan is selected, the PlanDashboard renders its own L A B S
  // header + project selector + system chips — we hide the default Labs
  // title so the dashboard owns the viewport.
  if (planId) {
    return <PlanDashboard planId={planId} />;
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-4">
        <h1 className="text-page-title">Labs</h1>
        <RuntimeControls />
      </div>

      <Tabs defaultValue="plans">
        <TabsList variant="line">
          <TabsTrigger value="plans">Plans</TabsTrigger>
          <TabsTrigger value="claude-code-workflow">Claude Code Pipeline</TabsTrigger>
          <TabsTrigger value="party">Party</TabsTrigger>
        </TabsList>
        <TabsContent value="plans">
          <PlansList />
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
