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
import { PlanReviewView } from './views/plan-review-view';
import { QaReviewView } from './views/qa-review-view';
import { DeployStageView } from './views/deploy-stage-view';
import { StagePlaceholder } from './views/stage-placeholder';
import { PlanPartyView } from './views/plan-party-view';
import { TimingPanel } from './timing-panel';

type StageId = PipelineStage['id'];
type ViewId = StageId | 'party';

const STAGE_KEY = 'labs.plan-dashboard.stage';
const SUBTAB_KEY = 'labs.plan-dashboard.subtab';
const VALID_STAGES: StageId[] = PIPELINE_STAGES.map((s) => s.id);
const VALID_SUBTABS: DevelopingSubtab[] = ['hierarchy', 'kanban', 'gantt'];

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
  const { data: plan, isLoading, error: planError, refetch } = usePlan(planId);
  const apply = useApplyPlanOutput(planId);

  // ── View/stage state ────────────────────────────────────────────────
  const urlStage = params.get('stage');
  const urlSubtab = params.get('subtab');

  // Default stage = plan.status. Concept+no epics → Concept. Party is opt-in.
  const defaultStage: StageId = plan
    ? (PIPELINE_STAGES[pipelineStageIndexFor(plan.status)]?.id ?? 'concept')
    : 'concept';

  // Active view can be any pipeline stage OR "party" (the right-side chip).
  //
  // Bug fix (2026-04-28): previously this fell through to localStorage when no
  // ?stage URL param was present. Result: a freshly-created plan in 'concept'
  // status would render as 'developing' (or wherever the operator was last
  // viewing on a different plan). The pipeline strip then displayed
  // "Developing — in progress" while the actual plan status was still
  // 'concept' — operator confusion, only visible by clicking Regenerate
  // (which the API rejects unless status === 'concept', proving the
  // mismatch). Now: defaultStage (= plan.status) wins when no URL param;
  // localStorage is only used to preserve the operator's last view DURING
  // an active plan dashboard session, not across plans.
  const activeView: ViewId = useMemo(() => {
    if (urlStage === 'party') return 'party';
    if (isStage(urlStage)) return urlStage;
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
  // "Plan not found" takes priority over "loading" — once the query has
  // errored (typically 404), stop the spinner and show a real error.
  const planNotFound =
    !!planError &&
    (planError instanceof Error ? /\b404\b|not.?found/i.test(planError.message) : false);

  if (planNotFound || (!isLoading && !plan)) {
    // Detect the common "ellipsis-pasted URL" case so the user gets a
    // precise fix instead of a generic "plan not found" page.
    const looksEllipsized =
      planId.includes('\u2026') || planId.includes('…') || planId.includes('%E2%80%A6');
    return (
      <div style={{ padding: 40, maxWidth: 640 }}>
        <Link
          href="/labs/"
          style={{ color: 'var(--text-dim)', fontSize: 12, textDecoration: 'none' }}
        >
          ← Back to Labs
        </Link>
        <h2 style={{ color: 'var(--destructive)', marginTop: 24, fontSize: 20 }}>Plan not found</h2>
        <p style={{ color: 'var(--text-dim)', marginTop: 10, lineHeight: 1.55, fontSize: 13 }}>
          No plan matches the ID in the URL:
        </p>
        <code
          style={{
            display: 'block',
            marginTop: 8,
            padding: '6px 10px',
            background: 'var(--bg-elev)',
            border: '1px solid var(--border)',
            borderRadius: 4,
            fontFamily: 'var(--font-mono)',
            fontSize: 12,
            color: 'var(--foreground)',
            wordBreak: 'break-all',
          }}
        >
          {planId}
        </code>
        {looksEllipsized && (
          <p
            style={{
              marginTop: 14,
              padding: 12,
              background: 'color-mix(in srgb, var(--warning, #d97706) 8%, transparent)',
              border: '1px solid color-mix(in srgb, var(--warning, #d97706) 30%, transparent)',
              borderRadius: 4,
              fontSize: 12.5,
              color: 'var(--text-dim)',
              lineHeight: 1.55,
            }}
          >
            <strong style={{ color: 'var(--foreground)' }}>
              The URL contains an ellipsis (…) character.
            </strong>{' '}
            This usually means the URL was copy-pasted from a display-truncated source (e.g. a chat
            message, dashboard link preview). Go back to Labs and click the plan directly from the
            list.
          </p>
        )}
      </div>
    );
  }

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
          </>
        )}

        {/* Story 1.8.4 — Timing panel: shown for developing and qa stages */}
        {(activeView === 'developing' || activeView === 'qa') && (
          <div style={{ marginBottom: 16 }}>
            <TimingPanel planId={planId} />
          </div>
        )}

        {activeView === 'qa' && <QaReviewView planId={planId} />}
        {activeView === 'deploy' && <DeployStageView plan={plan} />}
        {activeView === 'published' && (
          <StagePlaceholder
            stage="Published"
            note="Once the app ships to futurator.ai, this stage will surface the live URL, uptime, and post-launch metrics."
          />
        )}

        {activeView === 'party' && <PlanPartyView plan={plan} />}
      </div>
    </div>
  );
}
