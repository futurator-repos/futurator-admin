'use client';
import { OrbitControls, OrthographicCamera, useGLTF } from '@react-three/drei';
import { Canvas } from '@react-three/fiber';
import { Suspense, useMemo } from 'react';
import { CAST, CAST_BY_ID, modelUrlForKind } from '../cast';
import { useOfficeStore } from '../store';
import type { PersonaRole } from '../types';
import { ActionProcessor } from './action-processor';
import { AttentionTray, type AttentionSeverity } from './attention-tray';
import { Character } from './character';
import { Decorators } from './decorators';
import { ClaudeCodeSwarm } from './claude-code-swarm';
import { FailureBadge } from './failure-badge';
import { RetryHourglass } from './retry-hourglass';
import { EC2ProxyBoard, GanttProxyBoard, PlansProxyBoard } from './proxy-boards';
import {
  CHAIR_URL,
  COFFEE_TABLE_URL,
  COUCH_PILLOWS_URL,
  COUCH_URL,
  DESK_URL,
  deskSeatPose,
  LONG_TABLE_URL,
  ROUND_TABLE_URL,
} from './constants';
import { RoomProps, RoomScreens } from './decor';
import {
  CoffeeStation,
  Couch,
  ManagementTable,
  MeetingTable,
  SupervisorDesk,
  Workstations,
} from './furniture';
import { Rooms } from './rooms';
import { Whiteboard } from './whiteboard';

// Preload every asset the scene needs at module-init so the first render
// doesn't pop characters + furniture in separately.
//
// Epic F.4 note: testers (Nadia/Olaf/Priya/Quinn) reuse CharacterKinds
// already in the dev/reviewer pool (Casual_Female, Suit_Male, etc.), so
// their GLTF URLs overlap and `useGLTF.preload` is idempotent on the same
// URL. No additional asset fetches are triggered by the tester pool — the
// design-doc "lazy load tester GLTFs" is effectively free here.
[CHAIR_URL, DESK_URL, COFFEE_TABLE_URL, COUCH_URL, COUCH_PILLOWS_URL, ROUND_TABLE_URL, LONG_TABLE_URL].forEach(
  (u) => useGLTF.preload(u),
);
CAST.forEach((p) => useGLTF.preload(modelUrlForKind(p.look.kind)));

/**
 * Epic B props threaded from the AgenticOffice top-level, since the
 * attention aggregation is a hook and the Canvas cannot host hooks that
 * react-query manages outside the r3f tree.
 */
export interface OfficeSceneAttention {
  severity: AttentionSeverity;
  filteredCount: number;
  portfolioCount: number;
  onTrayClick: () => void;
}

export interface OfficeSceneProxies {
  /** EC2 status summary — drives the EC2 proxy board LEDs + count. */
  ec2: { daemonUp: boolean; apiOk: boolean; dbOk: boolean; runningJobs: number };
  /** Wave summary — one entry per wave across all active plans. */
  waves: { wave: number; count: number; doneCount: number }[];
  /** Per-plan tile content for the Plans proxy board. */
  plans: {
    planId: string;
    name: string;
    rigor: 'prototype' | 'mvp' | 'production' | undefined;
    storyCount: number;
    doneCount: number;
  }[];
  /** Open-modal callbacks — parent hoists modal state. */
  onOpenEc2: () => void;
  onOpenGantt: () => void;
  onOpenPlans: () => void;
}

export function OfficeScene({
  attention,
  proxies,
  claudeCodeCount = 0,
}: {
  attention?: OfficeSceneAttention;
  proxies?: OfficeSceneProxies;
  /**
   * Number of Claude CLI subprocesses currently live on the EC2 daemon.
   * Drives the little Claude Code creatures walking the server room.
   */
  claudeCodeCount?: number;
}) {
  // Which role sits at each dev/reviewer/tester desk — drives monitor theme
  // + content. Derived from each persona's *runtime* (seat + presence +
  // activity): only light a monitor when its occupant is physically there
  // and sitting. This keeps the office readable — empty desks stay dark,
  // and when someone walks to coffee / the couch / offstage, their
  // monitor goes dark too, exactly as a real desk would.
  //
  // Previously we lit all CAST-home desks unconditionally to fix the
  // "dead monitor after story done" bug — but that made every desk glow
  // forever, even with no one sitting at it.
  const assignmentsByStory = useOfficeStore((s) => s.assignmentsByStory);
  const runtimes = useOfficeStore((s) => s.runtimes);
  const roleByDeskSlot = useMemo(() => {
    const m = new Map<number, PersonaRole>();
    for (const persona of CAST) {
      const rt = runtimes[persona.id];
      if (!rt) continue;
      if (rt.presence !== 'onstage') continue;
      if (rt.activity !== 'sitting') continue;
      if (rt.seat?.kind !== 'desk') continue;
      m.set(rt.seat.slot, persona.role);
    }
    return m;
  }, [runtimes]);

  // Epic C: desk tags show the occupying plan's color. Only render when the
  // assignment's owner is currently sitting at the desk (otherwise the flag
  // floats above an empty chair, which reads as wrong).
  const planColorByDeskSlot = useMemo(() => {
    const m = new Map<number, string>();
    for (const a of Object.values(assignmentsByStory)) {
      if (!a.planColor) continue;
      const rt = runtimes[a.characterId];
      if (!rt) continue;
      if (rt.presence !== 'onstage') continue;
      if (rt.seat?.kind !== 'desk') continue;
      m.set(rt.seat.slot, a.planColor);
    }
    return m;
  }, [assignmentsByStory, runtimes]);

  // Supervisor seat shows the matrix theme whenever Ricardo is onstage.
  const ricardoPresence = useOfficeStore((s) => s.runtimes.ricardo.presence);
  const supervisorOccupied = ricardoPresence === 'onstage' || ricardoPresence === 'entering';

  // Epic B.5 — which desk slots have a currently-retrying story sitting
  // on them. `storyRetry` is keyed by storyId; cross-reference with
  // `assignmentsByStory` to find the deskSlot each retry is pinned to.
  const storyRetry = useOfficeStore((s) => s.storyRetry);
  const retryByDeskSlot = useMemo(() => {
    const m = new Map<number, { retryAfter: string; retryAttempt: number }>();
    for (const [storyId, state] of Object.entries(storyRetry)) {
      const assignment = assignmentsByStory[storyId];
      if (!assignment) continue;
      m.set(assignment.deskSlot, state);
    }
    return m;
  }, [storyRetry, assignmentsByStory]);

  // Failure badges — red pulsing flags above any desk whose occupying
  // story has failed (terminally) OR is at attempt ≥ 3. Uses kanban's
  // `failed` flag as the authoritative terminal-fail signal.
  const kanbanStories = useOfficeStore((s) => s.kanbanStories);
  const failureByDeskSlot = useMemo(() => {
    const m = new Map<number, { label: string; subLabel?: string }>();
    const failedStoryIds = new Set(kanbanStories.filter((k) => k.failed).map((k) => k.storyId));
    for (const a of Object.values(assignmentsByStory)) {
      if (failedStoryIds.has(a.storyId)) {
        m.set(a.deskSlot, { label: 'FAILED', subLabel: 'needs attention' });
      } else if (a.attempt >= 3) {
        m.set(a.deskSlot, { label: 'LAST TRY', subLabel: `attempt ${a.attempt}/3` });
      }
    }
    return m;
  }, [kanbanStories, assignmentsByStory]);

  return (
    <Canvas shadows dpr={[1, 2]}>
      {/* Isometric ortho camera aimed at main-office center */}
      <OrthographicCamera makeDefault position={[16, 16, 16]} zoom={32} near={0.1} far={200} />

      {/* Lights — ambient fill + key light casting shadows */}
      <ambientLight intensity={0.5} />
      <hemisphereLight args={['#c8d4ff', '#8a7a5a', 0.4]} />
      <directionalLight
        position={[10, 18, 10]}
        intensity={0.8}
        castShadow
        shadow-mapSize-width={2048}
        shadow-mapSize-height={2048}
        shadow-camera-left={-20}
        shadow-camera-right={30}
        shadow-camera-top={20}
        shadow-camera-bottom={-20}
        shadow-camera-near={0.5}
        shadow-camera-far={60}
      />

      <Suspense fallback={null}>
        {/* Rooms — walls, floors, doors */}
        <Rooms />

        {/* Main-office furniture */}
        <Workstations
          roleByDeskSlot={roleByDeskSlot}
          planColorByDeskSlot={planColorByDeskSlot}
        />
        <SupervisorDesk occupied={supervisorOccupied} />

        {/* Epic B.1–B.4: attention tray on Ricardo's desk. Parent passes
            severity + counts computed from the aggregated attention hook. */}
        {attention && (
          <AttentionTray
            severity={attention.severity}
            filteredCount={attention.filteredCount}
            portfolioCount={attention.portfolioCount}
            onClick={attention.onTrayClick}
          />
        )}

        {/* Epic D: in-scene proxy boards — low-fi status tiles, each
            clickable to open a 2D modal with full data. */}
        {proxies && (
          <>
            <EC2ProxyBoard
              daemonUp={proxies.ec2.daemonUp}
              apiOk={proxies.ec2.apiOk}
              dbOk={proxies.ec2.dbOk}
              runningJobs={proxies.ec2.runningJobs}
              onClick={proxies.onOpenEc2}
            />
            <GanttProxyBoard
              waveSummary={proxies.waves}
              onClick={proxies.onOpenGantt}
            />
            <PlansProxyBoard plans={proxies.plans} onClick={proxies.onOpenPlans} />
          </>
        )}

        {/* Claude Code creatures — one per live Claude CLI subprocess on
            the EC2 daemon. Bounded to the server room, fades in/out as
            the process count changes. */}
        <ClaudeCodeSwarm targetCount={claudeCodeCount} />

        {/* Epic B.5: retry hourglass — one per retrying dev desk. */}
        {Array.from(retryByDeskSlot.entries()).map(([slot, state]) => {
          const pose = deskSeatPose(slot);
          return (
            <RetryHourglass
              key={slot}
              worldPos={[pose.pos.x, pose.pos.y, pose.pos.z]}
              retryAfter={state.retryAfter}
              attempt={state.retryAttempt + 1}
            />
          );
        })}

        {/* Failure badges — red flags above desks with failed/at-last-try
            stories. Shows independently of retry hourglass so a story at
            attempt 3 waiting for its retry window shows BOTH badges. */}
        {Array.from(failureByDeskSlot.entries()).map(([slot, { label, subLabel }]) => {
          const pose = deskSeatPose(slot);
          return (
            <FailureBadge
              key={slot}
              worldPos={[pose.pos.x, pose.pos.y, pose.pos.z]}
              label={label}
              subLabel={subLabel}
            />
          );
        })}
        <CoffeeStation />
        <Couch />
        <Whiteboard />

        {/* Orchestrator decorators — wave bands, status rings, blocker
            cards, terminal-fail ribbons. Reads store.orchestrator. */}
        <Decorators />

        {/* Room-specific props */}
        <ManagementTable />
        <MeetingTable />

        {/* Room dressing + wall screens (KG/Gantt/Git/EC2) */}
        <RoomProps />
        <RoomScreens />

        {/* Every persona is mounted — they self-hide when presence is
            `offstage` so the draw cost is zero until a tracker drives
            them on. Devs/reviewers appear as `subagent_dispatch` fires. */}
        {CAST.map((p) => (
          <Character key={p.id} characterId={p.id} />
        ))}

        {/* Headless per-frame action drain — must live inside the Canvas */}
        <ActionProcessor />
      </Suspense>

      <OrbitControls
        makeDefault
        target={[0, 1, 0]}
        enablePan
        enableZoom
        enableRotate
        minDistance={5}
        maxDistance={50}
      />
    </Canvas>
  );
}
