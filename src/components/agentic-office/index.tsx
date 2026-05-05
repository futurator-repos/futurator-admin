'use client';
import { useQuery } from '@tanstack/react-query';
import { useCallback, useEffect, useMemo, useRef } from 'react';
import { api } from '@/lib/api-client';
import type { AppEntry } from '@/hooks/use-epic-workflow';
import { usePlansList } from '@/hooks/use-plans';
import { useAggregatedAttention } from '@/hooks/use-aggregated-attention';
import { useEc2Status } from '@/hooks/use-ec2-daemon';
import { AttentionPanel } from './overlays/attention-panel';
import { BoardModal } from './overlays/board-modal';
import {
  EC2BoardContent,
  GanttBoardContent,
  PlansBoardContent,
} from './overlays/board-contents';
import { CharacterPanel } from './overlays/character-panel';
import { KanbanBoard } from './overlays/kanban-board';
import { OfficeEventLog } from './overlays/event-log';
import { severityFromTop } from './scene/attention-tray';
import { useOfficeActions } from './scene/action-processor';
import { resolveSeatPose } from './scene/constants';
import { OfficeScene } from './scene/office-scene';
import { useOfficeStore } from './store';
import { EpicTracker } from './trackers/epic-tracker';

const IDLE_DEPART_MS = 10_000;

/**
 * Top-level Agentic Office component. Portfolio view — shows every
 * `in_development` app across every plan.
 *
 * Lifecycle:
 *   - Polls `/apps` every 5s for active epics.
 *   - When ≥1 epic is active: Milena + Ricardo enter + seat at home.
 *   - When all epics idle for >10s: Milena + Ricardo leave.
 *   - Per-epic `EpicTracker` mounts story trackers, drives Milena chat
 *     bubbles on transitions, and bridges QA/PO/Deploy job milestones.
 */
export function AgenticOffice() {
  const { data: apps } = useQuery({
    queryKey: ['published-apps'],
    queryFn: () => api.get<AppEntry[]>('/development/apps'),
    refetchInterval: 5000,
  });
  const setActiveEpics = useOfficeStore((s) => s.setActiveEpics);
  const actions = useOfficeActions();

  // ── Epic B: attention aggregation across currently-focused plans. ──
  // Portfolio planIds = distinct planIds on active kanban stories, minus
  // legacy null. Filter planIds = user's explicit kanban filter (if any).
  const kanbanStories = useOfficeStore((s) => s.kanbanStories);
  const selectedKanbanPlanIds = useOfficeStore((s) => s.selectedKanbanPlanIds);
  const setAttentionOpen = useOfficeStore((s) => s.setAttentionOpen);
  const { data: plans } = usePlansList();

  const portfolioPlanIds = useMemo(() => {
    const set = new Set<string>();
    for (const s of kanbanStories) if (s.planId) set.add(s.planId);
    return Array.from(set).sort();
  }, [kanbanStories]);

  const filteredPlanIds = useMemo(() => {
    if (selectedKanbanPlanIds.length === 0) return portfolioPlanIds;
    return selectedKanbanPlanIds.filter((id) => id !== '__unassigned__');
  }, [selectedKanbanPlanIds, portfolioPlanIds]);

  const filteredAttention = useAggregatedAttention(filteredPlanIds);
  const portfolioAttention = useAggregatedAttention(portfolioPlanIds);

  const planNameById = useMemo(() => {
    const map = new Map<string, string>();
    for (const p of plans ?? []) map.set(p.planId, p.displayName || p.name);
    return map;
  }, [plans]);

  const toggleAttentionOpen = useCallback(() => {
    const s = useOfficeStore.getState();
    setAttentionOpen(!s.attentionOpen);
  }, [setAttentionOpen]);

  const attentionProps = useMemo(
    () => ({
      severity: severityFromTop(filteredAttention.topSeverity),
      filteredCount: filteredAttention.unresolvedCount,
      portfolioCount: portfolioAttention.unresolvedCount,
      onTrayClick: toggleAttentionOpen,
    }),
    [filteredAttention, portfolioAttention, toggleAttentionOpen],
  );

  // ── Epic D: proxy-board props + modal wiring ─────────────────────────
  const openBoard = useOfficeStore((s) => s.openBoard);
  const setOpenBoard = useOfficeStore((s) => s.setOpenBoard);
  const { data: ec2Status } = useEc2Status(true);

  const ec2Props = useMemo(
    () => ({
      daemonUp: ec2Status?.daemonAlive === true,
      apiOk: true, // if this page loaded, the API is up
      dbOk: ec2Status?.daemonAlive === true, // proxy: daemon alive implies DB reachable
      runningJobs: ec2Status?.activeCount ?? 0,
    }),
    [ec2Status],
  );

  // One little Claude Code creature per live Claude CLI subprocess on the
  // EC2 daemon. `processes` is the authoritative list; fall back to
  // activeCount if it's missing for any reason.
  const claudeCodeCount =
    ec2Status?.processes?.length ?? ec2Status?.activeCount ?? 0;

  const waveSummary = useMemo(() => {
    const byWave = new Map<number, { count: number; doneCount: number }>();
    for (const s of kanbanStories) {
      const w = s.wave ?? 0;
      if (w === null) continue;
      const entry = byWave.get(w) ?? { count: 0, doneCount: 0 };
      entry.count += 1;
      if (s.column === 'done') entry.doneCount += 1;
      byWave.set(w, entry);
    }
    return Array.from(byWave.entries())
      .map(([wave, v]) => ({ wave, ...v }))
      .sort((a, b) => a.wave - b.wave);
  }, [kanbanStories]);

  const storyCountsByPlan = useMemo(() => {
    const m = new Map<string, { total: number; done: number }>();
    for (const s of kanbanStories) {
      if (!s.planId) continue;
      const entry = m.get(s.planId) ?? { total: 0, done: 0 };
      entry.total += 1;
      if (s.column === 'done') entry.done += 1;
      m.set(s.planId, entry);
    }
    return m;
  }, [kanbanStories]);

  const plansProxy = useMemo(() => {
    const byPlanId = new Map((plans ?? []).map((p) => [p.planId, p]));
    return portfolioPlanIds.slice(0, 6).map((planId) => {
      const p = byPlanId.get(planId);
      const counts = storyCountsByPlan.get(planId) ?? { total: 0, done: 0 };
      return {
        planId,
        name: p?.displayName ?? p?.name ?? planId.slice(0, 8),
        rigor: undefined as 'prototype' | 'mvp' | 'production' | undefined,
        storyCount: counts.total,
        doneCount: counts.done,
      };
    });
  }, [portfolioPlanIds, plans, storyCountsByPlan]);

  const ganttWaveSummary = useMemo(() => {
    // Group waves by plan for the Gantt modal; the proxy itself uses the
    // flat all-plans summary.
    return kanbanStories
      .filter((s) => s.planId && s.wave !== null)
      .reduce<
        { planId: string; wave: number; count: number; doneCount: number }[]
      >((acc, s) => {
        const key = `${s.planId}:${s.wave}`;
        const existing = acc.find((x) => `${x.planId}:${x.wave}` === key);
        if (existing) {
          existing.count += 1;
          if (s.column === 'done') existing.doneCount += 1;
        } else {
          acc.push({
            planId: s.planId as string,
            wave: s.wave as number,
            count: 1,
            doneCount: s.column === 'done' ? 1 : 0,
          });
        }
        return acc;
      }, []);
  }, [kanbanStories]);

  const plansById = useMemo(() => {
    const m = new Map((plans ?? []).map((p) => [p.planId, p]));
    return m;
  }, [plans]);

  const proxyProps = useMemo(
    () => ({
      ec2: ec2Props,
      waves: waveSummary,
      plans: plansProxy,
      onOpenEc2: () => setOpenBoard('ec2'),
      onOpenGantt: () => setOpenBoard('gantt'),
      onOpenPlans: () => setOpenBoard('plans'),
    }),
    [ec2Props, waveSummary, plansProxy, setOpenBoard],
  );

  const activeEpicIds = useMemo(() => {
    if (!apps) return [];
    return apps.filter((a) => a.appStatus === 'in_development').map((a) => a.epicId);
  }, [apps]);

  useEffect(() => {
    setActiveEpics(activeEpicIds);
  }, [activeEpicIds, setActiveEpics]);

  // Milena + Ricardo — portfolio-wide lifecycle based on whether ANY epic
  // is active. Debounce the departure so brief gaps don't cause them to
  // flicker out and back in.
  const activeCount = activeEpicIds.length;
  const onstageRef = useRef(false);
  const firstRunRef = useRef(true);
  const departTimerRef = useRef<number | null>(null);

  useEffect(() => {
    const clearDepart = () => {
      if (departTimerRef.current !== null) {
        window.clearTimeout(departTimerRef.current);
        departTimerRef.current = null;
      }
    };

    if (activeCount > 0) {
      clearDepart();
      if (!onstageRef.current) {
        onstageRef.current = true;

        if (firstRunRef.current) {
          // Cold-load with epics already active — teleport to seats
          // instead of walking in from the entrance. Keeps the initial
          // paint clean and avoids the "huge slide-in" glitch on refresh.
          firstRunRef.current = false;
          const store = useOfficeStore.getState();
          const ricardoPose = resolveSeatPose('supervisor', 0);
          const milenaPose = resolveSeatPose('whiteboard', 0);
          store.updateRuntime('ricardo', {
            position: ricardoPose.pos.clone(),
            facing: ricardoPose.facing,
            activity: 'sitting',
            seat: { kind: 'supervisor', slot: 0 },
            target: null,
            presence: 'onstage',
            presenceScale: 1,
          });
          store.updateRuntime('milena', {
            position: milenaPose.pos.clone(),
            facing: milenaPose.facing,
            activity: 'pointing',
            seat: { kind: 'whiteboard', slot: 0 },
            target: null,
            presence: 'onstage',
            presenceScale: 1,
          });
        } else {
          // Live transition from idle → active (during a session): keep
          // the full "walk in from the entrance" entrance.
          actions.enter('ricardo');
          actions.gotoSeat('ricardo', { kind: 'supervisor', slot: 0 });
          actions.chat('ricardo', 'Dispatching the team…', '🎯');

          actions.enter('milena');
          actions.gotoSeat('milena', { kind: 'whiteboard', slot: 0 });
          actions.chat('milena', 'Planning the wave!', '📋');
        }
      }
    } else if (onstageRef.current && departTimerRef.current === null) {
      departTimerRef.current = window.setTimeout(() => {
        onstageRef.current = false;
        actions.milestone('ricardo', 'All done for now.', '👋', 'neutral');
        actions.leave('ricardo');
        actions.leave('milena');
        departTimerRef.current = null;
      }, IDLE_DEPART_MS);
    }

    return clearDepart;
  }, [activeCount, actions]);

  return (
    <div className="relative h-[calc(100vh-4rem)] w-full overflow-hidden rounded-lg border border-border bg-background">
      <OfficeScene
        attention={attentionProps}
        proxies={proxyProps}
        claudeCodeCount={claudeCodeCount}
      />

      {/* Per-epic trackers — headless components that wire DDB state +
          event streams into the office action queue. */}
      {activeEpicIds.map((id) => (
        <EpicTracker key={id} epicId={id} />
      ))}

      {/* HUD — status + kanban + event log + character detail panel */}
      <div className="pointer-events-none absolute left-3 top-3 rounded-md border border-border/60 bg-black/40 px-3 py-1.5 text-[11px] text-white/80 backdrop-blur">
        Agentic Office — {activeCount} active {activeCount === 1 ? 'epic' : 'epics'}
      </div>
      <KanbanBoard />
      <AttentionPanel
        planIdsForQuery={filteredPlanIds}
        result={filteredAttention}
        planNameById={planNameById}
      />
      <OfficeEventLog />
      <CharacterPanel />

      {/* Epic D — proxy-board modals */}
      <BoardModal
        open={openBoard === 'ec2'}
        onClose={() => setOpenBoard(null)}
        title="EC2 Monitor"
        subtitle="Live daemon status + running jobs"
      >
        <EC2BoardContent />
      </BoardModal>
      <BoardModal
        open={openBoard === 'gantt'}
        onClose={() => setOpenBoard(null)}
        title="Gantt — wave shape"
        subtitle={`${portfolioPlanIds.length} plan${portfolioPlanIds.length === 1 ? '' : 's'}`}
      >
        <GanttBoardContent
          waves={ganttWaveSummary}
          planIds={portfolioPlanIds}
          plansById={plansById}
        />
      </BoardModal>
      <BoardModal
        open={openBoard === 'plans'}
        onClose={() => setOpenBoard(null)}
        title="Plans"
        subtitle={`${portfolioPlanIds.length} active`}
      >
        <PlansBoardContent
          plans={(plans ?? []).filter((p) => portfolioPlanIds.includes(p.planId))}
          storyCounts={storyCountsByPlan}
        />
      </BoardModal>
    </div>
  );
}
