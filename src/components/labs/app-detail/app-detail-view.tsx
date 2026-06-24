'use client';

import { useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { useApp } from '@/hooks/use-apps';
import { useGithubRepoSummary } from '@/hooks/use-github-repo-summary';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { AppDetailHeader } from './app-detail-header';
import { DirtyTreeBanner } from './dirty-tree-banner';
import { ConcurrencyBanner } from './concurrency-banner';
import { PlanTimeline } from './plan-timeline';
import { NewPlanModal } from './new-plan-modal';
import { DeploysPanel } from './deploys-panel';
import { AppSettingsDialog } from './app-settings-dialog';
import { DeleteAppDialog } from './delete-app-dialog';
import { V2RoadmapStrip } from './v2-roadmap-strip';
import { SourceTabContent } from './source-tab';
import { PerformanceTab } from './performance-tab';
import { AppPartyView } from './app-party-view';
import { AssessTab } from './assess/assess-tab';
import { RefactorGraph } from './assess/refactor-graph';
import { useAppAudits, useRefactorGraphAvailable } from '@/hooks/use-app-audit';

interface DeployRow {
  jobId: string;
  createdAt?: string;
  planId?: string;
}

/**
 * App detail view — mounted by `/labs/page.tsx` when `?appId=X` is in the
 * URL. Avoids dynamic route segments (incompatible with `output: 'export'`).
 */
export function AppDetailView({ appId }: { appId: string }) {
  const { data, isLoading, error } = useApp(appId);
  const [newPlanOpen, setNewPlanOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);

  // Allow deep-linking to a specific tab via `?tab=party` (used by Debates).
  const params = useSearchParams();
  const tabParam = params.get('tab');
  const initialTab =
    tabParam === 'party' ||
    tabParam === 'source' ||
    tabParam === 'performance' ||
    tabParam === 'assess' ||
    tabParam === 'graph'
      ? tabParam
      : 'overview';

  // App-level Graph tab: enabled once an assessment has produced + uploaded a
  // code graph. Gated on the S3 graph (HEAD) — resilient to the durable audit
  // table (the graph's home is S3). The durable list still feeds hotspots.
  const { data: auditsData } = useAppAudits(appId);
  const latestAudit = auditsData?.audits?.[0] ?? null;
  const { data: graphInS3 } = useRefactorGraphAvailable(appId);
  const hasGraph = !!graphInS3;

  // Pre-fetch repo summary so the Source tab has defaultBranch without an
  // additional waterfall. We can only know if the app is bootstrapped after the
  // app query resolves — so we pass `null` to keep the hook disabled until then.
  // The `enabled` guard inside the hook handles the null case.
  const bootstrappedAppId = data?.app?.boilerplateType && data.app.bootstrappedAt ? appId : null;
  const { data: repoData } = useGithubRepoSummary(bootstrappedAppId);

  if (isLoading) {
    return <div className="p-6 text-muted-foreground">Loading…</div>;
  }
  if (error) {
    return (
      <div className="rounded-lg border border-destructive/30 bg-destructive/5 p-4 text-sm text-destructive">
        Failed to load App: {(error as Error).message}
      </div>
    );
  }
  if (!data) {
    return <div className="p-6 text-muted-foreground">App not found.</div>;
  }

  const { app, plans, activePlan } = data;
  const recentDeploys = (data.recentDeploys ?? []) as DeployRow[];
  const isDirty = app.workingTreeStatus === 'dirty-from-abandoned-plan';
  const canStartNew = !activePlan && !isDirty;
  const blockReason = isDirty
    ? 'Working tree needs cleanup — click "Mark resolved" first.'
    : activePlan
      ? `${activePlan.iterationLabel ?? 'A Plan'} is currently active.`
      : undefined;

  const lastAbandoned = plans
    .filter((p) => p.status === 'abandoned')
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0];

  const defaultBranch = repoData?.repo.default_branch;
  const hasSourceTab = !!(app.boilerplateType && app.bootstrappedAt);
  // Refactoring Assessment (Epic D) — brownfield apps carry an explicit
  // githubRepoUrl (any org). The /assess endpoint enforces brownfield-only
  // server-side; this is the UX gate (FR30).
  const hasAssessTab = !!app.githubRepoUrl;

  return (
    <div className="space-y-6">
      <AppDetailHeader
        app={app}
        onOpenSettings={() => setSettingsOpen(true)}
        onOpenDelete={() => setDeleteOpen(true)}
      />

      {isDirty ? (
        <DirtyTreeBanner
          appId={app.appId}
          abandonedPlanLabel={lastAbandoned?.iterationLabel ?? lastAbandoned?.displayName}
        />
      ) : activePlan ? (
        <ConcurrencyBanner appId={app.appId} activePlan={activePlan} />
      ) : null}

      <V2RoadmapStrip />

      {/* Story 1.5.2 — Tabbed content: Overview + Source + Performance */}
      <Tabs defaultValue={initialTab}>
        <TabsList>
          <TabsTrigger value="overview">Overview</TabsTrigger>
          {hasSourceTab && <TabsTrigger value="source">Source</TabsTrigger>}
          {hasAssessTab && <TabsTrigger value="assess">Assess</TabsTrigger>}
          {hasAssessTab && (
            <TabsTrigger
              value="graph"
              disabled={!hasGraph}
              title={hasGraph ? undefined : 'Run an assessment first to generate the code graph'}
            >
              Graph
            </TabsTrigger>
          )}
          <TabsTrigger value="party">Party</TabsTrigger>
          {/* Story 1.8.5 — Performance tab (always shown; empty state when no plans) */}
          <TabsTrigger value="performance">Performance</TabsTrigger>
        </TabsList>

        <TabsContent value="overview" className="mt-4 space-y-6">
          <PlanTimeline
            appId={app.appId}
            plans={plans}
            canStartNew={canStartNew}
            blockReason={blockReason}
            onStartNew={() => setNewPlanOpen(true)}
          />
          <DeploysPanel app={app} recentDeploys={recentDeploys} />
        </TabsContent>

        {hasSourceTab && (
          <TabsContent value="source" className="mt-4">
            <SourceTabContent app={app} defaultBranch={defaultBranch} />
          </TabsContent>
        )}

        {hasAssessTab && (
          <TabsContent value="assess" className="mt-4">
            <AssessTab app={app} />
          </TabsContent>
        )}

        {hasAssessTab && hasGraph && (
          <TabsContent value="graph" className="mt-4">
            <RefactorGraph
              appId={app.appId}
              hotspots={latestAudit?.hotspots ?? []}
              graphAvailable={hasGraph}
            />
          </TabsContent>
        )}

        <TabsContent value="party" className="mt-4">
          <AppPartyView app={app} />
        </TabsContent>

        <TabsContent value="performance" className="mt-4">
          <PerformanceTab appId={app.appId} app={app} />
        </TabsContent>
      </Tabs>

      <NewPlanModal
        appId={app.appId}
        hasExistingPlans={plans.length > 0}
        open={newPlanOpen}
        onOpenChange={setNewPlanOpen}
      />
      <AppSettingsDialog app={app} open={settingsOpen} onOpenChange={setSettingsOpen} />
      <DeleteAppDialog app={app} open={deleteOpen} onOpenChange={setDeleteOpen} />
    </div>
  );
}
