'use client';

/**
 * PlanSpecDashboard — Labs3 top-level composition (the pipeline-3 / SDD sibling
 * of legacy PlanDashboard). Read-only visualization of the plan-spec-graph:
 * it fetches the StoryNode snapshot ONCE (useStoryNodes), builds the grouped
 * model, and fans the uniform Labs3ViewProps into each surface's slot.
 *
 * STAGE-FIRST navigation (design I8 v2): the plan lifecycle is five navigable
 * stages (concept · development · qa · deployment · publish), each owning its
 * own panel and ordered subtab set. The LifecycleStrip IS the navigator; the
 * selected stage renders its subtab row (hidden when the stage has a single
 * surface) then the active view. The topological-frontier PipelineStrip lives
 * INSIDE the development panel only.
 *
 * URL state (static-export friendly — query params only):
 *   ?planId=<uuid>   — which plan's spec graph to view (required)
 *   ?stage=<id>      — selected lifecycle stage (deep-linkable)
 *   ?subtab=<id>     — active surface within the stage (deep-linkable)
 * Legacy `?subtab=`-only URLs resolve their stage via `stageForSubtab`.
 * Both are mirrored to per-plan localStorage keys (labs3.* namespace).
 */

import { useEffect, useMemo, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { Loader2 } from 'lucide-react';
import Link from 'next/link';
import { usePlan } from '@/hooks/use-plans';
import { useApp } from '@/hooks/use-apps';
import { useStoryNodes } from '@/hooks/use-story-nodes';
import { useDaemonStatus } from '@/hooks/use-daemon-status';
import { Labs3Header } from './labs3-header';
import { ProjectHero } from './project-hero';
import { LifecycleStrip } from './lifecycle-strip';
import { PipelineStrip } from './pipeline-strip';
import { SubtabRow } from './developing-subtabs';
import { buildStoryGraphModel, type Labs3ViewProps } from './adapter';
import {
  isStage,
  isSubtab,
  stageDef,
  stageForStatus,
  stageForSubtab,
  stageStorageKey,
  subtabStorageKey,
  subtabDefs,
  type Labs3Stage,
  type Labs3Subtab,
} from './constants';
import { SpecGraphView } from '../views/spec-graph-view';
import { Labs3GitGraphView } from '../views/git-graph-view';
import { HierarchyView } from '../views/hierarchy-view';
import { StreamView } from '../views/stream-view';
import { QaReviewView } from '../views/qa-review-view';
import { GrowthView } from '../views/growth-view';
import { PlanningView } from '../views/planning-view';
import { DeploymentView } from '../views/deploy-view';
import { PublishView } from '../views/publish-view';
// Legacy code-knowledge-graph view — project-scoped Memgraph/Mycelium viewer.
// Reused here as the 'codegraph' surface (the REAL "Graph" tab).
import { GraphView } from '@/components/labs/plan-dashboard/views/graph-view';

/** appId is the App slug; fall back to the workingDir basename when absent. */
function resolveAppId(plan: { appId?: string; workingDir: string } | undefined): string | null {
  if (!plan) return null;
  return plan.appId ?? plan.workingDir.split('/').filter(Boolean).pop() ?? null;
}

export function PlanSpecDashboard({ planId }: { planId: string }) {
  const router = useRouter();
  const params = useSearchParams();

  const { data: plan, isLoading, error: planError } = usePlan(planId);
  const appId = resolveAppId(plan);
  const { data: appRow } = useApp(plan?.appId ?? null);
  const githubRepoUrl = appRow?.app?.githubRepoUrl ?? null;

  // Single snapshot fetch — refetchInterval self-gates on active stories.
  const { data: stories } = useStoryNodes(planId);
  const rows = useMemo(() => stories ?? [], [stories]);
  const { data: daemon } = useDaemonStatus();

  // Dispatch warning: stories are ingested and pending, but the daemon's
  // ready-frontier isn't 'on' — so nothing will actually build.
  const frontier = daemon?.p3ReadyFrontier;
  const dispatchStalled =
    rows.length > 0 &&
    daemon?.alive === true &&
    frontier != null &&
    frontier !== 'on' &&
    rows.some((r) => r.state === 'ready' || r.state === 'blocked');
  const model = useMemo(() => buildStoryGraphModel(rows), [rows]);

  // ── Stage + subtab state ────────────────────────────────────────────
  // pacman3 canary (2026-07-03): router.replace schedules the searchParams
  // update as a low-priority TRANSITION and this dashboard re-renders on every
  // poll — the pending switch was starved for seconds, so clicks felt dead.
  // Flip LOCAL override state immediately on click for instant response; the
  // URL sync trails behind for deep-links, reconciled here for back/forward.
  const urlStage = params.get('stage');
  const urlSubtab = params.get('subtab');

  const [stageOverride, setStageOverride] = useState<Labs3Stage | null>(null);
  const [lastUrlStage, setLastUrlStage] = useState(urlStage);
  if (urlStage !== lastUrlStage) {
    setLastUrlStage(urlStage);
    setStageOverride(isStage(urlStage) ? urlStage : null);
  }

  const [subtabOverride, setSubtabOverride] = useState<Labs3Subtab | null>(null);
  const [lastUrlSubtab, setLastUrlSubtab] = useState(urlSubtab);
  if (urlSubtab !== lastUrlSubtab) {
    setLastUrlSubtab(urlSubtab);
    setSubtabOverride(isSubtab(urlSubtab) ? urlSubtab : null);
  }

  // selectedStage precedence: override(click) > URL ?stage= > legacy
  // ?subtab=→stage > localStorage > stageForStatus(plan).
  const selectedStage: Labs3Stage = useMemo(() => {
    if (stageOverride) return stageOverride;
    if (isStage(urlStage)) return urlStage;
    if (!urlStage && isSubtab(urlSubtab)) return stageForSubtab(urlSubtab);
    if (typeof window !== 'undefined' && plan) {
      const stored = window.localStorage.getItem(stageStorageKey(planId));
      if (isStage(stored)) return stored;
    }
    return plan ? stageForStatus(plan.status, plan) : 'concept';
  }, [stageOverride, urlStage, urlSubtab, plan, planId]);

  const def = stageDef(selectedStage);
  const stageSubtabs = def.subtabs;

  // activeSubtab precedence within the stage: override(click) > URL > storage,
  // each only if valid FOR THIS STAGE; else the stage's default subtab.
  const activeSubtab: Labs3Subtab = useMemo(() => {
    // stageSubtabs / def derive from selectedStage — recompute here so the
    // memo depends only on selectedStage (not the outer derived consts).
    const d = stageDef(selectedStage);
    const stored =
      typeof window !== 'undefined' && plan
        ? window.localStorage.getItem(subtabStorageKey(planId))
        : null;
    for (const cand of [subtabOverride, urlSubtab, stored]) {
      if (isSubtab(cand) && d.subtabs.includes(cand)) return cand;
    }
    return d.defaultSubtab;
  }, [subtabOverride, urlSubtab, plan, planId, selectedStage]);

  // Persist selection per-plan (only once the plan — hence its stage — is known).
  useEffect(() => {
    if (typeof window === 'undefined' || !plan) return;
    window.localStorage.setItem(stageStorageKey(planId), selectedStage);
    window.localStorage.setItem(subtabStorageKey(planId), activeSubtab);
  }, [selectedStage, activeSubtab, plan, planId]);

  function pushUrl(
    next: { stage: Labs3Stage; subtab: Labs3Subtab },
    extra?: Record<string, string>,
  ) {
    const sp = new URLSearchParams(params.toString());
    sp.set('planId', planId);
    sp.set('stage', next.stage);
    sp.set('subtab', next.subtab);
    if (extra) for (const [k, v] of Object.entries(extra)) sp.set(k, v);
    // scroll:false — selecting a story deep in a list must not yank the viewport.
    router.replace(`/labs3/?${sp.toString()}`, { scroll: false });
  }

  function goToStage(stage: Labs3Stage) {
    const d = stageDef(stage);
    // Keep the current surface if the target stage also owns it, else its default.
    const nextSub = d.subtabs.includes(activeSubtab) ? activeSubtab : d.defaultSubtab;
    setStageOverride(stage);
    setSubtabOverride(nextSub);
    pushUrl({ stage, subtab: nextSub });
  }

  function goToSubtab(subtab: Labs3Subtab, extra?: Record<string, string>) {
    // A subtab may belong to a different stage (onSelectStory → 'stories',
    // onOpenGraph → 'graph'); resolve the owning stage when out of the current.
    const targetStage = stageDef(selectedStage).subtabs.includes(subtab)
      ? selectedStage
      : stageForSubtab(subtab);
    setStageOverride(targetStage);
    setSubtabOverride(subtab);
    pushUrl({ stage: targetStage, subtab }, extra);
  }

  // ── Loading / not-found ─────────────────────────────────────────────
  const planNotFound =
    !!planError &&
    (planError instanceof Error ? /\b404\b|not.?found/i.test(planError.message) : false);

  if (planNotFound || (!isLoading && !plan)) {
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
        Loading plan spec…
      </div>
    );
  }

  // ── Uniform view props passed into every surface slot ───────────────
  const viewProps: Labs3ViewProps = {
    planId,
    appId,
    stories: rows,
    plan,
    githubRepoUrl,
    onSelectStory: (storyId) => goToSubtab('stories', { storyId }),
  };

  return (
    <div style={{ color: 'var(--foreground)' }}>
      <Labs3Header planId={planId} appId={appId} appLabel={plan.displayName ?? plan.name} />
      {dispatchStalled && (
        <div
          role="status"
          style={{
            margin: '0 0 4px',
            padding: '9px 14px',
            borderRadius: 8,
            border: '1px solid var(--warning, #f97316)',
            background: 'color-mix(in srgb, var(--warning, #f97316) 10%, transparent)',
            color: 'var(--foreground)',
            fontSize: 12.5,
            lineHeight: 1.5,
          }}
        >
          Stories are ingested but the daemon dispatch frontier is <code>{frontier}</code> — nothing
          will build until <code>P3_READY_FRONTIER=on</code> on the daemon. The graph below is the
          plan, not live progress.
        </div>
      )}
      <ProjectHero plan={plan} model={model} />

      <LifecycleStrip plan={plan} selectedStage={selectedStage} onSelectStage={goToStage} />

      {/* ── Selected stage panel ─────────────────────────────────────── */}
      {selectedStage === 'development' && (
        <PipelineStrip model={model} onSelectBatch={() => goToSubtab('graph')} />
      )}

      {stageSubtabs.length > 1 && (
        <SubtabRow
          tabs={subtabDefs(stageSubtabs)}
          active={activeSubtab}
          onChange={(t) => goToSubtab(t)}
        />
      )}

      <div style={{ paddingTop: 24, paddingBottom: 60 }}>
        {activeSubtab === 'plan-stage' && <PlanningView {...viewProps} />}

        {activeSubtab === 'graph' && <SpecGraphView {...viewProps} />}

        {/* Code knowledge graph — files/symbols/imports grown by the compile
            phase after every green story. projectId = appId (legacy GraphView). */}
        {activeSubtab === 'codegraph' && <GraphView projectId={appId} />}

        {activeSubtab === 'gitgraph' && (
          <Labs3GitGraphView
            appId={appId}
            githubRepoUrl={githubRepoUrl}
            planName={plan.displayName ?? plan.name}
            planSlug={plan.name}
            planId={plan.planId}
            stories={rows}
          />
        )}

        {activeSubtab === 'stories' && <HierarchyView {...viewProps} />}

        {activeSubtab === 'qa' && <QaReviewView {...viewProps} />}

        {activeSubtab === 'growth' && (
          <GrowthView
            planId={planId}
            appId={appId}
            projectSlug={appId ?? ''}
            onOpenGraph={() => goToSubtab('codegraph')}
          />
        )}

        {activeSubtab === 'stream' && <StreamView {...viewProps} />}

        {activeSubtab === 'deploy' && <DeploymentView {...viewProps} />}

        {activeSubtab === 'publish' && <PublishView {...viewProps} />}
      </div>
    </div>
  );
}
