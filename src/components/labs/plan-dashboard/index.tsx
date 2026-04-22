'use client';

/**
 * PlanDashboard — top-level composition.
 *
 * Navigation model: the Project Pipeline is the primary nav. Each stage
 * (Concept / Developing / QA Review / Deploy / Published) is a clickable
 * view. Party Mode is an always-visible button anchored to the right of the
 * pipeline — it's independent of plan status/stage so the operator can chat
 * about anything at any time.
 *
 * The Developing stage contains four sub-tabs (Hierarchy, Kanban, Gantt,
 * Deploy) that inherit the current behavior.
 *
 * URL state:
 *   ?planId=<uuid>           — which plan to view (required)
 *   ?stage=concept|developing|qa|deploy|published|party   — active stage
 *   ?subtab=hierarchy|kanban|gantt|deploy                 — within Developing
 *   ?pmJobId=<uuid>          — PM job to poll + apply after create/regenerate
 *
 * Stage defaults to `plan.status` when not in URL. Sub-tab defaults to
 * hierarchy. Both are mirrored to localStorage for continuity.
 */

import { useEffect, useMemo, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { Loader2 } from 'lucide-react';
import Link from 'next/link';
import { usePlan, useApplyPlanOutput } from '@/hooks/use-plans';
import type { AgentJob } from '@/types/agent-orchestrator';
import { useAgentJob, useAgentJobs } from '@/hooks/use-agent-job';
import { LabsHeader } from './labs-header';
import { ProjectHero } from './project-hero';
import { BudgetBanner } from './budget-banner';
import { Pipeline } from './pipeline';
import { DevelopingSubtabs, type DevelopingSubtab } from './developing-subtabs';
import { aggregatePlan, buildDashboardPlan } from './adapter';
import { PIPELINE_STAGES, pipelineStageIndexFor, type PipelineStage } from './constants';
import { HierarchyView } from './views/hierarchy-view';
import { KanbanView } from './views/kanban-view';
import { GanttView } from './views/gantt-view';
import { DeployView } from './views/deploy-view';
import { PlanReviewView } from './views/plan-review-view';
import { StagePlaceholder } from './views/stage-placeholder';
import { Party } from '@/components/labs/party';

type StageId = PipelineStage['id'];
type ViewId = StageId | 'party';

const STAGE_KEY = 'labs.plan-dashboard.stage';
const SUBTAB_KEY = 'labs.plan-dashboard.subtab';
const VALID_STAGES: StageId[] = PIPELINE_STAGES.map((s) => s.id);
const VALID_SUBTABS: DevelopingSubtab[] = ['hierarchy', 'kanban', 'gantt', 'deploy'];

function isStage(v: string | null): v is StageId {
  return v !== null && (VALID_STAGES as string[]).includes(v);
}
function isSubtab(v: string | null): v is DevelopingSubtab {
  return v !== null && (VALID_SUBTABS as string[]).includes(v);
}

export function PlanDashboard({ planId }: { planId: string }) {
  const router = useRouter();
  const params = useSearchParams();
  const urlPmJobId = params.get('pmJobId');
  const { data: plan, isLoading, refetch } = usePlan(planId);
  const apply = useApplyPlanOutput(planId);

  // ── View/stage state ────────────────────────────────────────────────
  const urlStage = params.get('stage');
  const urlSubtab = params.get('subtab');

  // Default stage = plan.status. Concept+no epics → Concept. Party is opt-in.
  const defaultStage: StageId = plan
    ? (PIPELINE_STAGES[pipelineStageIndexFor(plan.status)]?.id ?? 'concept')
    : 'concept';

  // Active view can be any pipeline stage OR "party" (the right-side chip).
  const activeView: ViewId = useMemo(() => {
    if (urlStage === 'party') return 'party';
    if (isStage(urlStage)) return urlStage;
    if (typeof window !== 'undefined') {
      const stored = window.localStorage.getItem(STAGE_KEY);
      if (stored === 'party') return 'party';
      if (isStage(stored)) return stored;
    }
    return defaultStage;
  }, [urlStage, defaultStage]);

  const activeSubtab: DevelopingSubtab = useMemo(() => {
    if (isSubtab(urlSubtab)) return urlSubtab;
    if (typeof window !== 'undefined') {
      const stored = window.localStorage.getItem(SUBTAB_KEY);
      if (isSubtab(stored)) return stored;
    }
    return 'hierarchy';
  }, [urlSubtab]);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    window.localStorage.setItem(STAGE_KEY, activeView);
    window.localStorage.setItem(SUBTAB_KEY, activeSubtab);
  }, [activeView, activeSubtab]);

  function navigate(nextStage: ViewId, nextSubtab?: DevelopingSubtab) {
    const sp = new URLSearchParams(params.toString());
    sp.set('stage', nextStage);
    if (nextSubtab) sp.set('subtab', nextSubtab);
    // Don't accumulate pmJobId once it's been consumed.
    router.replace(`/labs/?${sp.toString()}`);
  }

  const goToStage = (s: StageId) => navigate(s);
  const goToParty = () => navigate('party');
  const goToSubtab = (t: DevelopingSubtab) => navigate('developing', t);

  // ── PM job polling + auto-apply ────────────────────────────────────
  const [localPmJobId, setLocalPmJobId] = useState<string | null>(null);
  const pmJobId = localPmJobId || urlPmJobId;
  const { data: pmJob } = useAgentJob(pmJobId);

  const [applied, setApplied] = useState<Set<string>>(new Set());
  useEffect(() => {
    if (!pmJob || !pmJobId || !plan) return;
    if (pmJob.status !== 'COMPLETED') return;
    if (applied.has(pmJobId)) return;
    if ((plan.epicIds?.length ?? 0) > 0) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setApplied((s) => new Set(s).add(pmJobId));
      return;
    }
    setApplied((s) => new Set(s).add(pmJobId));
    apply
      .mutateAsync({ jobId: pmJobId })
      .then(() => {
        // Strip pmJobId from URL once consumed; preserve stage/subtab.
        const sp = new URLSearchParams(params.toString());
        sp.delete('pmJobId');
        router.replace(`/labs/?${sp.toString()}`);
        refetch();
      })
      .catch((err) => console.error('[PlanDashboard] apply failed', err));
  }, [pmJob, pmJobId, plan, applied, apply, refetch, router, params]);

  // ── Job metric hydration (for Hierarchy/Kanban/Gantt views) ────────
  const jobIds = useMemo<string[]>(() => {
    if (!plan?.epics) return [];
    const ids: string[] = [];
    for (const e of plan.epics) {
      for (const s of e.stories) {
        if (s.jobId) ids.push(s.jobId);
      }
    }
    return ids;
  }, [plan]);
  const hasRunningJobs = useMemo(
    () =>
      !!plan?.epics?.some((e) =>
        e.stories.some(
          (s) => s.status === 'running' || s.status === 'in_review' || s.status === 'fixing',
        ),
      ),
    [plan],
  );
  const jobQueries = useAgentJobs(jobIds, hasRunningJobs);
  const jobsById = useMemo<Record<string, AgentJob>>(() => {
    const out: Record<string, AgentJob> = {};
    jobQueries.forEach((q, idx) => {
      if (q.data) out[jobIds[idx]] = q.data;
    });
    return out;
  }, [jobQueries, jobIds]);

  // ── Live tick for Gantt ────────────────────────────────────────────
  const [tNow, setTNow] = useState<number>(() => Date.now());
  useEffect(() => {
    if (activeView !== 'developing' || activeSubtab !== 'gantt') return;
    const id = window.setInterval(() => setTNow(Date.now()), 500);
    return () => window.clearInterval(id);
  }, [activeView, activeSubtab]);

  const dashboard = useMemo(
    () => (plan ? buildDashboardPlan(plan, jobsById, { now: tNow }) : null),
    [plan, jobsById, tNow],
  );
  const planAgg = useMemo(() => (dashboard ? aggregatePlan(dashboard) : null), [dashboard]);

  // ── Loading / not-found states ─────────────────────────────────────
  if (isLoading || !plan) {
    return (
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          padding: 80,
          color: 'var(--text-mute)',
          gap: 10,
          fontFamily: 'var(--font-mono)',
          fontSize: 12,
          letterSpacing: '0.08em',
          textTransform: 'uppercase',
        }}
      >
        <Loader2 size={14} className="animate-spin" />
        Loading plan…
      </div>
    );
  }

  if (!plan.planId) {
    return (
      <div style={{ padding: 40 }}>
        <Link
          href="/labs/"
          style={{ color: 'var(--text-dim)', fontSize: 12, textDecoration: 'none' }}
        >
          ← Back to Labs
        </Link>
        <p style={{ color: 'var(--destructive)', marginTop: 16 }}>Plan not found.</p>
      </div>
    );
  }

  if (!dashboard || !planAgg) return null;

  return (
    <div style={{ color: 'var(--foreground)' }}>
      <LabsHeader currentPlanId={planId} />
      <ProjectHero plan={dashboard} pct={planAgg.progress} />
      <BudgetBanner planId={plan.planId} rigor={plan.rigor} totalCostUsd={plan.totalCostUsd || 0} />
      <Pipeline
        status={plan.status}
        activeStageId={activeView === 'party' ? defaultStage : activeView}
        onStageChange={goToStage}
        onPartyClick={goToParty}
        isPartyActive={activeView === 'party'}
      />

      {/* Developing-specific sub-tabs render only when viewing Developing. */}
      {activeView === 'developing' && (
        <DevelopingSubtabs active={activeSubtab} onChange={goToSubtab} />
      )}

      <div style={{ paddingTop: 24, paddingBottom: 60 }}>
        {activeView === 'concept' && (
          <PlanReviewView
            plan={plan}
            pmJobStatus={pmJob?.status}
            pmJobId={pmJobId}
            applyPending={apply.isPending}
            onPmJobStarted={(jobId) => {
              setLocalPmJobId(jobId);
              setApplied(new Set());
            }}
            onPlanStarted={() => {
              refetch();
              // Auto-advance the viewer to Developing when start succeeds.
              navigate('developing', 'hierarchy');
            }}
          />
        )}

        {activeView === 'developing' && (
          <>
            {activeSubtab === 'hierarchy' && (
              <HierarchyView
                plan={dashboard}
                agg={planAgg}
                rawPlan={plan}
                pmJobStatus={pmJob?.status}
                pmJobId={pmJobId}
                applyPending={apply.isPending}
              />
            )}
            {activeSubtab === 'kanban' && <KanbanView plan={dashboard} />}
            {activeSubtab === 'gantt' && <GanttView plan={dashboard} tNow={tNow} />}
            {activeSubtab === 'deploy' && <DeployView plan={plan} />}
          </>
        )}

        {activeView === 'qa' && (
          <StagePlaceholder
            stage="QA Review"
            note="Visual QA + PO audit reports will live here once the dev-run completes. For now, run QA from Developing → Deploy."
          />
        )}
        {activeView === 'deploy' && (
          <StagePlaceholder
            stage="Deploy"
            note="Promotion to production + deploy history will live here. Live dev server, Visual QA, and Publish controls are under Developing → Deploy."
          />
        )}
        {activeView === 'published' && (
          <StagePlaceholder
            stage="Published"
            note="Once the app ships to futurator.ai, this stage will surface the live URL, uptime, and post-launch metrics."
          />
        )}

        {activeView === 'party' && <Party />}
      </div>
    </div>
  );
}
