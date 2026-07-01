'use client';

/**
 * PlanSpecDashboard — Labs3 top-level composition (the pipeline-3 / SDD sibling
 * of legacy PlanDashboard). Read-only visualization of the plan-spec-graph:
 * it fetches the StoryNode snapshot ONCE (useStoryNodes), builds the grouped
 * model, and fans the uniform Labs3ViewProps into each surface's slot.
 *
 * Surfaces (sub-tabs):
 *   graph    — dependency DAG over cohortBatch levels (B3)
 *   gitgraph — per-story commits on branch plan/<id> (B4)
 *   stories  — cohort → batch → story hierarchy + live log/retries (B5)
 *   qa       — bound-AC testBinding rollup + delivery verdict (B6)
 *   growth   — skill catalog + reflections + instinct loop / gate blocks (B7)
 *   stream   — plan-wide forensic surface for all story-dev jobs (B5)
 *
 * URL state (static-export friendly — query params only):
 *   ?planId=<uuid>   — which plan's spec graph to view (required)
 *   ?subtab=<id>     — active surface (defaults to graph; mirrored to
 *                      localStorage under labs3.* keys, never colliding with
 *                      legacy Labs view state)
 */

import { useEffect, useMemo } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { Loader2 } from 'lucide-react';
import Link from 'next/link';
import { usePlan } from '@/hooks/use-plans';
import { useApp } from '@/hooks/use-apps';
import { useStoryNodes } from '@/hooks/use-story-nodes';
import { Labs3Header } from './labs3-header';
import { ProjectHero } from './project-hero';
import { PipelineStrip } from './pipeline-strip';
import { DevelopingSubtabs } from './developing-subtabs';
import { buildStoryGraphModel, type Labs3ViewProps } from './adapter';
import { LABS3_SUBTABS, SUBTAB_KEY, type Labs3Subtab } from './constants';
import { SpecGraphView } from '../views/spec-graph-view';
import { Labs3GitGraphView } from '../views/git-graph-view';
import { HierarchyView } from '../views/hierarchy-view';
import { StreamView } from '../views/stream-view';
import { QaReviewView } from '../views/qa-review-view';
import { GrowthView } from '../views/growth-view';
// Legacy code-knowledge-graph view — project-scoped Memgraph/Mycelium viewer.
// Reused here as the 'codegraph' surface (the REAL "Graph" tab).
import { GraphView } from '@/components/labs/plan-dashboard/views/graph-view';

const VALID_SUBTABS: Labs3Subtab[] = LABS3_SUBTABS.map((t) => t.id);

function isSubtab(v: string | null): v is Labs3Subtab {
  return v !== null && (VALID_SUBTABS as string[]).includes(v);
}

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
  const model = useMemo(() => buildStoryGraphModel(rows), [rows]);

  // ── Sub-tab state (URL > localStorage > default 'graph') ────────────
  const urlSubtab = params.get('subtab');
  const activeSubtab: Labs3Subtab = useMemo(() => {
    if (isSubtab(urlSubtab)) return urlSubtab;
    if (typeof window !== 'undefined') {
      const stored = window.localStorage.getItem(SUBTAB_KEY);
      if (isSubtab(stored)) return stored;
    }
    return 'graph';
  }, [urlSubtab]);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    window.localStorage.setItem(SUBTAB_KEY, activeSubtab);
  }, [activeSubtab]);

  function goToSubtab(next: Labs3Subtab, extra?: Record<string, string>) {
    const sp = new URLSearchParams(params.toString());
    sp.set('subtab', next);
    if (extra) for (const [k, v] of Object.entries(extra)) sp.set(k, v);
    router.replace(`/labs3/?${sp.toString()}`);
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
      <Labs3Header planId={planId} />
      <ProjectHero plan={plan} model={model} />
      <PipelineStrip model={model} onSelectBatch={() => goToSubtab('graph')} />

      <DevelopingSubtabs active={activeSubtab} onChange={(t) => goToSubtab(t)} />

      <div style={{ paddingTop: 24, paddingBottom: 60 }}>
        {activeSubtab === 'graph' && <SpecGraphView {...viewProps} />}

        {/* Code knowledge graph — files/symbols/imports grown by the compile phase
            after every green story. projectId = appId (same as legacy GraphView). */}
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
            onOpenGraph={() => goToSubtab('graph')}
          />
        )}

        {activeSubtab === 'stream' && <StreamView {...viewProps} />}
      </div>
    </div>
  );
}
