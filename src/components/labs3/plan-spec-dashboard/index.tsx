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
  const { data: daemon } = useDaemonStatus();

  // Dispatch warning: stories are ingested and pending, but the daemon's
  // ready-frontier isn't 'on' — so nothing will actually build. Without this the
  // graph just sits idle and looks like a silent hang.
  const frontier = daemon?.p3ReadyFrontier;
  const dispatchStalled =
    rows.length > 0 &&
    daemon?.alive === true &&
    frontier != null &&
    frontier !== 'on' &&
    rows.some((r) => r.state === 'ready' || r.state === 'blocked');
  const model = useMemo(() => buildStoryGraphModel(rows), [rows]);

  // ── Sub-tab state (local override > URL > localStorage > 'graph') ────
  // pacman3 canary bug (2026-07-03): router.replace schedules the searchParams
  // update as a low-priority TRANSITION, and this dashboard re-renders on every
  // daemon/story/event poll — the pending tab switch was starved for seconds, so
  // clicks felt dead ("like a layer blocking the tabs"). Flip LOCAL state
  // immediately on click for an instant response; the URL sync trails behind for
  // deep-links, and the effect below reconciles back/forward navigation.
  const urlSubtab = params.get('subtab');
  const [subtabOverride, setSubtabOverride] = useState<Labs3Subtab | null>(null);
  // A URL change (back/forward, external link) wins over a stale override —
  // React's render-time state-adjustment pattern (no effect, no extra commit).
  const [lastUrlSubtab, setLastUrlSubtab] = useState(urlSubtab);
  if (urlSubtab !== lastUrlSubtab) {
    setLastUrlSubtab(urlSubtab);
    if (isSubtab(urlSubtab)) setSubtabOverride(urlSubtab);
  }
  const activeSubtab: Labs3Subtab = useMemo(() => {
    if (subtabOverride) return subtabOverride;
    if (isSubtab(urlSubtab)) return urlSubtab;
    if (typeof window !== 'undefined') {
      const stored = window.localStorage.getItem(SUBTAB_KEY);
      if (isSubtab(stored)) return stored;
    }
    return 'graph';
  }, [subtabOverride, urlSubtab]);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    window.localStorage.setItem(SUBTAB_KEY, activeSubtab);
  }, [activeSubtab]);

  function goToSubtab(next: Labs3Subtab, extra?: Record<string, string>) {
    setSubtabOverride(next); // instant — never wait on the router transition
    const sp = new URLSearchParams(params.toString());
    sp.set('subtab', next);
    if (extra) for (const [k, v] of Object.entries(extra)) sp.set(k, v);
    // scroll:false — selecting a story deep in the Stories list must NOT yank the
    // viewport back to the top. Without this, clicking a batch-1/2 story looked
    // like a full page "refresh" (batch-0 clicks were invisible only because the
    // scroll was already at the top).
    router.replace(`/labs3/?${sp.toString()}`, { scroll: false });
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
      <LifecycleStrip plan={plan} />
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
