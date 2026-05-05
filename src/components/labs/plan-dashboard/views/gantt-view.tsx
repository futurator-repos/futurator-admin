'use client';

/**
 * Live Gantt view — renders ACTUAL story timelines, not a simulation.
 *
 * Design (distilled from docs/concepts/agent-roadmap-gantt.jsx):
 *
 *   At wall-clock time t, for each story:
 *     - QUEUED (not started):     projectedEnd = actualStart + plannedDur
 *     - RUNNING on-time:           projectedEnd = actualStart + plannedDur
 *     - RUNNING past plannedDur:   projectedEnd = t   ← LIVE — recomputes every tick
 *     - DONE:                      projectedEnd = actualStart + actualDur
 *
 *   Wave's projectedEnd = max(projectedEnd) of its stories.
 *   Next wave's actualStart = previous wave projectedEnd + WAVE_GAP.
 *
 *   KEY CONSEQUENCE: when a running story is overrunning, its projectedEnd
 *   equals `t`. As `t` advances (500ms tick), downstream stories slide
 *   rightward in real-time. The moment the slow story finishes, its
 *   projectedEnd freezes at its actual completion time and downstream
 *   positions stabilize.
 *
 * Anchoring to real time:
 *   - `t0` = plan.startedAtIso if present, else the earliest story createdAt,
 *     else 0 (draft plan). Everything is expressed in SECONDS since t0.
 *   - For stories with a real job createdAt, `actualStart` uses the real
 *     timestamp. For unstarted stories, it's derived from wave topology.
 *   - `plannedDur` is the adapter default (180s / 3min) — tunable later.
 */

import { useMemo, useState, useRef, useEffect, useCallback } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import type {
  DashboardEpic,
  DashboardPlan,
  DashboardStory,
  DashboardWave,
} from '../adapter';
import { fmtClock, fmtCost } from '../adapter';
import { ACTIVE_STORY_STATUSES, STORY_STATUS_META } from '../constants';

const WAVE_GAP_SEC = 2;
const EPIC_GAP_SEC = 4;

// ── Simulated story (computed each render) ──────────────────────────

interface SimStory extends DashboardStory {
  actualStart: number; // seconds since t0
  plannedStart: number; // seconds since t0
  plannedEnd: number;
  barWidth: number; // actualDur or elapsed (at least plannedDur while running)
  actualDur: number | null; // resolved only when done
  projectedEnd: number; // see docs above
  displacement: number; // actualStart - plannedStart
  isOverrunning: boolean;
  wasLate: boolean;
  simStatus: 'queued' | 'running' | 'done';
}

interface Simulation {
  stories: Record<string, SimStory>;
  allStories: SimStory[];
  totalPlanned: number;
  totalActual: number;
  totalTime: number;
  t: number; // seconds since t0 at render time
  t0Ms: number; // the chosen origin in wall-clock ms
}

function computeT0(plan: DashboardPlan): number {
  // Prefer plan.startedAt. Fallback: earliest story startedAtIso. Final: now.
  if (plan.startedAtIso) return Date.parse(plan.startedAtIso);
  for (const e of plan.epics) {
    for (const w of e.waves) {
      for (const s of w.stories) {
        if (s.startedAtIso) return Date.parse(s.startedAtIso);
      }
    }
  }
  return Date.now();
}

function simulate(plan: DashboardPlan, tNowMs: number): Simulation {
  const t0Ms = computeT0(plan);
  const t = Math.max(0, (tNowMs - t0Ms) / 1000);

  const stories: Record<string, SimStory> = {};
  let cursor = 0;
  let plannedCursor = 0;

  for (const epic of plan.epics) {
    for (const wave of epic.waves) {
      const simList: SimStory[] = [];

      for (const s of wave.stories) {
        const plannedDur = s.plannedSec;
        const plannedStart = plannedCursor;
        const plannedEnd = plannedCursor + plannedDur;

        // Anchor actualStart: real job createdAt if present; else the
        // epic/wave cursor.
        let actualStart = cursor;
        if (s.startedAtIso) {
          const anchored = Math.max(0, (Date.parse(s.startedAtIso) - t0Ms) / 1000);
          actualStart = anchored;
        }

        // Classify: queued / running / done — using real status.
        let simStatus: SimStory['simStatus'];
        let projectedEnd: number;
        let barWidth: number;
        let actualDur: number | null = null;
        let isOverrunning = false;

        if (s.status === 'done' || s.status === 'failed') {
          simStatus = 'done';
          // Real duration if we have both timestamps; else fall back to plan.
          if (s.finishedAtIso && s.startedAtIso) {
            actualDur =
              Math.max(0, (Date.parse(s.finishedAtIso) - Date.parse(s.startedAtIso)) / 1000);
          } else if (s.actualSec != null) {
            actualDur = s.actualSec;
          } else {
            actualDur = plannedDur;
          }
          barWidth = actualDur;
          projectedEnd = actualStart + actualDur;
        } else if (ACTIVE_STORY_STATUSES.includes(s.status)) {
          simStatus = 'running';
          const elapsed = Math.max(0, t - actualStart);
          isOverrunning = elapsed > plannedDur;
          // Bar width is at LEAST plannedDur while running; grows once we pass.
          barWidth = Math.max(plannedDur, elapsed);
          // THE CRITICAL LINE: when overrunning, projectedEnd = t. Recomputes
          // on every render tick, so downstream bars slide right.
          projectedEnd = isOverrunning ? t : actualStart + plannedDur;
        } else {
          // pending, queued, blocked, skipped — treat as queued for layout.
          simStatus = 'queued';
          // For queued stories that haven't really started yet, use the cursor
          // (ignore any stale real actualStart anchor).
          actualStart = s.status === 'pending' ? cursor : actualStart;
          barWidth = plannedDur;
          projectedEnd = actualStart + plannedDur;
        }

        const displacement = actualStart - plannedStart;
        const wasLate =
          simStatus === 'done' && actualDur != null && actualDur > plannedDur * 1.05;

        const sim: SimStory = {
          ...s,
          plannedStart,
          plannedEnd,
          actualStart,
          actualDur,
          barWidth,
          projectedEnd,
          displacement,
          isOverrunning,
          wasLate,
          simStatus,
        };
        stories[s.id] = sim;
        simList.push(sim);
      }

      if (simList.length > 0) {
        const waveEnd = Math.max(...simList.map((x) => x.projectedEnd));
        const wavePlannedEnd = Math.max(...simList.map((x) => x.plannedEnd));
        cursor = waveEnd + WAVE_GAP_SEC;
        plannedCursor = wavePlannedEnd + WAVE_GAP_SEC;
      }
    }
    cursor += EPIC_GAP_SEC;
    plannedCursor += EPIC_GAP_SEC;
  }

  const allStories = Object.values(stories);
  const totalPlanned = allStories.length
    ? Math.max(...allStories.map((s) => s.plannedEnd))
    : 0;
  const totalActual = allStories.length
    ? Math.max(...allStories.map((s) => s.projectedEnd))
    : 0;
  // Viewport: at least 35% past planned end, or 5s past current projected end,
  // whichever is larger. Keeps the current time indicator visible without
  // zooming out wildly on a sudden overrun.
  const totalTime = Math.max(totalPlanned * 1.35, totalActual + 5, 30);

  return { stories, allStories, totalPlanned, totalActual, totalTime, t, t0Ms };
}

// ── Color helpers (verbatim from prototype) ──────────────────────────

function stColor(s: SimStory): string {
  if (s.simStatus === 'queued') return 'var(--text-faint)';
  if (s.simStatus === 'done') return s.wasLate ? 'var(--amber)' : 'var(--success)';
  if (s.isOverrunning) return 'var(--destructive)';
  return 'var(--accent-purple)';
}

function barBg(s: SimStory): string {
  if (s.simStatus === 'queued')
    return 'color-mix(in srgb, var(--text-faint) 25%, transparent)';
  if (s.simStatus === 'done') {
    if (s.wasLate)
      return 'linear-gradient(90deg, color-mix(in srgb, var(--amber) 75%, transparent), var(--amber))';
    return 'linear-gradient(90deg, color-mix(in srgb, var(--success) 70%, transparent), var(--success))';
  }
  if (s.isOverrunning)
    return 'linear-gradient(90deg, color-mix(in srgb, var(--destructive) 80%, transparent), var(--destructive))';
  return 'linear-gradient(90deg, color-mix(in srgb, var(--accent-purple) 65%, transparent), var(--accent-purple))';
}

// ── Top-level view ───────────────────────────────────────────────────

export function GanttView({
  plan,
  tNow,
}: {
  plan: DashboardPlan;
  tNow: number;
}) {
  const sim = useMemo(() => simulate(plan, tNow), [plan, tNow]);

  const initialExpanded = useMemo(() => {
    const o: Record<string, boolean> = { plan: true };
    plan.epics.forEach((e) => {
      o[e.id] = true;
      e.waves.forEach((w) => {
        o[w.id] = true;
      });
    });
    return o;
  }, [plan.epics]);
  const [exp, setExp] = useState<Record<string, boolean>>(initialExpanded);
  const [drawerStory, setDrawerStory] = useState<SimStory | null>(null);

  const done = sim.allStories.filter((s) => s.simStatus === 'done').length;
  const running = sim.allStories.filter((s) => s.simStatus === 'running').length;
  const stressed = sim.allStories.filter((s) => s.isOverrunning).length;
  const queued = sim.allStories.filter((s) => s.simStatus === 'queued').length;
  const totalCost = sim.allStories.reduce((a, s) => a + s.cost, 0);
  const overallProg =
    sim.allStories.length > 0
      ? sim.allStories.reduce((a, s) => {
          if (s.simStatus === 'done') return a + 100;
          if (s.simStatus === 'running') {
            const elapsed = Math.max(0, sim.t - s.actualStart);
            return a + Math.min(99, (elapsed / s.plannedSec) * 100);
          }
          return a;
        }, 0) / sim.allStories.length
      : 0;
  const totalDisp = Math.max(0, sim.totalActual - sim.totalPlanned);

  if (plan.epics.length === 0) {
    return (
      <div
        style={{
          padding: 40,
          textAlign: 'center',
          color: 'var(--text-mute)',
          border: '1px solid var(--border)',
          borderRadius: 10,
          fontFamily: 'var(--font-mono)',
          fontSize: 11,
        }}
      >
        — no epics to render —
      </div>
    );
  }

  return (
    <div
      style={{
        background: 'var(--bg-elev)',
        border: '1px solid var(--border)',
        borderRadius: 10,
        overflow: 'hidden',
      }}
    >
      {/* Top bar — live clock + status chips */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 12,
          padding: '12px 18px',
          background:
            'linear-gradient(135deg, var(--bg-elev), var(--surface))',
          borderBottom: '1px solid var(--border)',
          flexWrap: 'wrap',
        }}
      >
        <div
          style={{
            padding: '5px 14px',
            borderRadius: 6,
            background: 'var(--surface)',
            border: '1px solid var(--border)',
            fontFamily: 'var(--font-mono)',
            fontSize: 18,
            fontWeight: 700,
            color: 'var(--foreground)',
            minWidth: 78,
            textAlign: 'center',
            fontVariantNumeric: 'tabular-nums',
          }}
        >
          {fmtClock(sim.t)}
        </div>
        <div
          style={{
            fontFamily: 'var(--font-mono)',
            fontSize: 9,
            color: 'var(--text-faint)',
            textTransform: 'uppercase',
            letterSpacing: '0.18em',
          }}
        >
          live · anchored to plan start
        </div>

        <div style={{ position: 'relative', width: 40, height: 40 }}>
          <svg width="40" height="40" viewBox="0 0 40 40">
            <circle
              cx="20"
              cy="20"
              r="17"
              fill="none"
              stroke="var(--border)"
              strokeWidth="3"
            />
            <circle
              cx="20"
              cy="20"
              r="17"
              fill="none"
              stroke={
                overallProg >= 99.9
                  ? 'var(--success)'
                  : stressed > 0
                    ? 'var(--destructive)'
                    : 'var(--accent-purple)'
              }
              strokeWidth="3"
              strokeDasharray={`${(overallProg / 100) * 106.8} 106.8`}
              strokeLinecap="round"
              transform="rotate(-90 20 20)"
            />
          </svg>
          <div
            style={{
              position: 'absolute',
              inset: 0,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              fontSize: 10,
              fontWeight: 700,
              fontFamily: 'var(--font-mono)',
              color: 'var(--foreground)',
            }}
          >
            {Math.round(overallProg)}%
          </div>
        </div>

        <div
          style={{
            display: 'flex',
            gap: 6,
            marginLeft: 'auto',
            flexWrap: 'wrap',
          }}
        >
          {[
            { l: 'Done', v: done, c: 'var(--success)' },
            { l: 'Live', v: running, c: 'var(--accent-purple)' },
            { l: 'Stress', v: stressed, c: 'var(--destructive)' },
            { l: 'Queue', v: queued, c: 'var(--text-faint)' },
          ].map((s) => (
            <StatChip key={s.l} label={s.l} value={String(s.v)} color={s.c} />
          ))}
          <StatChip label="Cost" value={`$${totalCost.toFixed(2)}`} color="var(--amber)" />
          {totalDisp > 0.5 && (
            <StatChip
              label="Slip"
              value={`+${fmtClock(totalDisp)}`}
              color="var(--destructive)"
            />
          )}
        </div>
      </div>

      {/* Grid + tree */}
      <div style={{ position: 'relative' }}>
        <TimeRuler totalTime={sim.totalTime} t={sim.t} />
        <div style={{ position: 'relative', minWidth: 900 }}>
          <GridLines totalTime={sim.totalTime} t={sim.t} />
          <PlanNode
            plan={plan}
            exp={exp}
            setExp={setExp}
            sim={sim}
            onSelect={setDrawerStory}
          />
        </div>
      </div>

      {/* Legend */}
      <div
        style={{
          display: 'flex',
          gap: 14,
          padding: '10px 20px',
          borderTop: '1px solid var(--border)',
          background: 'var(--background)',
          fontFamily: 'var(--font-mono)',
          fontSize: 9,
          color: 'var(--text-faint)',
          flexWrap: 'wrap',
        }}
      >
        <span>
          <span style={{ color: 'var(--accent-purple)' }}>━</span> Developing
        </span>
        <span>
          <span style={{ color: 'var(--success)' }}>━</span> Done on time
        </span>
        <span>
          <span style={{ color: 'var(--destructive)' }}>━</span> Overrunning
          now
        </span>
        <span>
          <span style={{ color: 'var(--amber)' }}>━</span> Done late
        </span>
        <span>
          <span style={{ color: 'var(--text-faint)' }}>┅</span> Planned position
        </span>
        <span style={{ marginLeft: 'auto' }}>
          Downstream slides right as upstream overruns · click any bar for
          details
        </span>
      </div>

      {drawerStory && (
        <GanttDrawer story={drawerStory} onClose={() => setDrawerStory(null)} />
      )}
    </div>
  );
}

function StatChip({
  label,
  value,
  color,
}: {
  label: string;
  value: string;
  color: string;
}) {
  return (
    <div
      style={{
        textAlign: 'center',
        padding: '3px 8px',
        borderRadius: 5,
        background: `color-mix(in srgb, ${color} 10%, transparent)`,
        border: `1px solid color-mix(in srgb, ${color} 22%, transparent)`,
        minWidth: 44,
      }}
    >
      <div
        style={{
          fontFamily: 'var(--font-mono)',
          fontSize: 14,
          fontWeight: 700,
          color,
          fontVariantNumeric: 'tabular-nums',
        }}
      >
        {value}
      </div>
      <div
        style={{
          fontFamily: 'var(--font-mono)',
          fontSize: 7,
          color: 'var(--text-faint)',
          textTransform: 'uppercase',
          letterSpacing: '0.08em',
        }}
      >
        {label}
      </div>
    </div>
  );
}

// ── Time ruler / grid ────────────────────────────────────────────────

function TimeRuler({ totalTime, t }: { totalTime: number; t: number }) {
  const step = totalTime > 1800 ? 300 : totalTime > 600 ? 120 : totalTime > 180 ? 30 : 10;
  const marks: number[] = [];
  for (let i = 0; i <= totalTime + step; i += step) marks.push(i);
  const toP = (v: number) => (v / totalTime) * 100;
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'stretch',
        height: 26,
        borderBottom: '2px solid var(--border)',
        background: 'var(--background)',
      }}
    >
      <div
        style={{
          width: 300,
          minWidth: 300,
          borderRight: '1px solid var(--border)',
          display: 'flex',
          alignItems: 'center',
          paddingLeft: 16,
          fontFamily: 'var(--font-mono)',
          fontSize: 9,
          color: 'var(--text-faint)',
          textTransform: 'uppercase',
          letterSpacing: '0.1em',
        }}
      >
        Timeline
      </div>
      <div style={{ flex: 1, position: 'relative' }}>
        {marks
          .filter((m) => m <= totalTime)
          .map((m) => (
            <div
              key={m}
              style={{
                position: 'absolute',
                left: `${toP(m)}%`,
                top: 0,
                bottom: 0,
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                justifyContent: 'flex-end',
              }}
            >
              <span
                style={{
                  fontFamily: 'var(--font-mono)',
                  fontSize: 8,
                  color:
                    m % (step * 3) === 0
                      ? 'var(--text-mute)'
                      : 'var(--text-faint)',
                  marginBottom: 2,
                }}
              >
                {fmtClock(m)}
              </span>
              <div
                style={{
                  width: 1,
                  height: m % (step * 3) === 0 ? 8 : 4,
                  background:
                    m % (step * 3) === 0
                      ? 'var(--border-2)'
                      : 'var(--border)',
                }}
              />
            </div>
          ))}
        {/* Now indicator */}
        <div
          style={{
            position: 'absolute',
            left: `${Math.min(toP(t), 100)}%`,
            top: 0,
            bottom: -2,
            width: 2,
            background: 'var(--amber)',
            borderRadius: 1,
            boxShadow: '0 0 8px color-mix(in srgb, var(--amber) 40%, transparent)',
            zIndex: 10,
          }}
        >
          <div
            style={{
              position: 'absolute',
              top: -2,
              left: -5,
              width: 12,
              height: 6,
              background: 'var(--amber)',
              borderRadius: '2px 2px 0 0',
            }}
          />
        </div>
      </div>
    </div>
  );
}

function GridLines({ totalTime, t }: { totalTime: number; t: number }) {
  const step = totalTime > 1800 ? 300 : totalTime > 600 ? 120 : totalTime > 180 ? 30 : 10;
  const lines: number[] = [];
  for (let i = 0; i <= totalTime + step; i += step) lines.push(i);
  const toP = (v: number) => (v / totalTime) * 100;
  return (
    <div
      style={{
        position: 'absolute',
        top: 0,
        left: 300,
        right: 0,
        bottom: 0,
        pointerEvents: 'none',
        zIndex: 0,
      }}
    >
      {lines
        .filter((i) => i <= totalTime)
        .map((i) => (
          <div
            key={i}
            style={{
              position: 'absolute',
              left: `${toP(i)}%`,
              top: 0,
              bottom: 0,
              width: 1,
              background:
                i % (step * 3) === 0
                  ? 'color-mix(in srgb, var(--border-2) 40%, transparent)'
                  : 'color-mix(in srgb, var(--border) 40%, transparent)',
            }}
          />
        ))}
      <div
        style={{
          position: 'absolute',
          left: `${Math.min(toP(t), 100)}%`,
          top: 0,
          bottom: 0,
          width: 1,
          background: 'color-mix(in srgb, var(--amber) 20%, transparent)',
          zIndex: 1,
        }}
      />
    </div>
  );
}

// ── Tree rendering ───────────────────────────────────────────────────

function PlanNode({
  plan,
  exp,
  setExp,
  sim,
  onSelect,
}: {
  plan: DashboardPlan;
  exp: Record<string, boolean>;
  setExp: React.Dispatch<React.SetStateAction<Record<string, boolean>>>;
  sim: Simulation;
  onSelect: (s: SimStory) => void;
}) {
  const open = exp.plan;
  const toggle = useCallback(
    (id: string) => setExp((p) => ({ ...p, [id]: !p[id] })),
    [setExp],
  );
  return (
    <>
      <AggRow
        type="plan"
        label={`${plan.name} — ${plan.intent}`}
        stories={sim.allStories}
        totalTime={sim.totalTime}
        depth={0}
        hasCh
        open={open}
        onToggle={() => toggle('plan')}
      />
      {open &&
        plan.epics.map((e) => (
          <EpicNode
            key={e.id}
            epic={e}
            exp={exp}
            toggle={toggle}
            sim={sim}
            onSelect={onSelect}
          />
        ))}
    </>
  );
}

function EpicNode({
  epic,
  exp,
  toggle,
  sim,
  onSelect,
}: {
  epic: DashboardEpic;
  exp: Record<string, boolean>;
  toggle: (id: string) => void;
  sim: Simulation;
  onSelect: (s: SimStory) => void;
}) {
  const open = exp[epic.id];
  const stories = epic.waves
    .flatMap((w) => w.stories.map((s) => sim.stories[s.id]).filter(Boolean));
  return (
    <>
      <AggRow
        type="epic"
        label={`${epic.label} — ${epic.title}`}
        stories={stories}
        totalTime={sim.totalTime}
        depth={1}
        hasCh
        open={open}
        onToggle={() => toggle(epic.id)}
      />
      {open &&
        epic.waves.map((w) => (
          <WaveNode
            key={w.id}
            wave={w}
            exp={exp}
            toggle={toggle}
            sim={sim}
            onSelect={onSelect}
          />
        ))}
    </>
  );
}

function WaveNode({
  wave,
  exp,
  toggle,
  sim,
  onSelect,
}: {
  wave: DashboardWave;
  exp: Record<string, boolean>;
  toggle: (id: string) => void;
  sim: Simulation;
  onSelect: (s: SimStory) => void;
}) {
  const open = exp[wave.id];
  const stories = wave.stories.map((s) => sim.stories[s.id]).filter(Boolean);
  return (
    <>
      <AggRow
        type="wave"
        label={wave.label}
        parallelCount={stories.length > 1 ? stories.length : undefined}
        stories={stories}
        totalTime={sim.totalTime}
        depth={2}
        hasCh
        open={open}
        onToggle={() => toggle(wave.id)}
      />
      {open &&
        stories.map((s) => (
          <StoryBarRow key={s.id} story={s} totalTime={sim.totalTime} onSelect={onSelect} />
        ))}
    </>
  );
}

const TYPE_ICON: Record<'plan' | 'epic' | 'wave', string> = {
  plan: '◆',
  epic: '■',
  wave: '⧫',
};
const TYPE_COLOR: Record<'plan' | 'epic' | 'wave', string> = {
  plan: 'var(--amber)',
  epic: 'var(--accent-blue)',
  wave: 'var(--accent-purple)',
};

function AggRow({
  type,
  label,
  stories,
  totalTime,
  depth,
  hasCh,
  open,
  onToggle,
  parallelCount,
}: {
  type: 'plan' | 'epic' | 'wave';
  label: string;
  stories: SimStory[];
  totalTime: number;
  depth: number;
  hasCh: boolean;
  open: boolean;
  onToggle: () => void;
  parallelCount?: number;
}) {
  const color = TYPE_COLOR[type];
  const icon = TYPE_ICON[type];
  const indent = depth * 18;
  return (
    <div
      style={{
        display: 'flex',
        minHeight: type === 'wave' ? 30 : 36,
        borderBottom: '1px solid var(--border)',
      }}
    >
      <div
        onClick={hasCh ? onToggle : undefined}
        style={{
          width: 300,
          minWidth: 300,
          display: 'flex',
          alignItems: 'center',
          paddingLeft: 12 + indent,
          paddingRight: 10,
          borderRight: '1px solid var(--border)',
          cursor: hasCh ? 'pointer' : 'default',
          userSelect: 'none',
          background:
            depth === 0 ? 'color-mix(in srgb, var(--foreground) 2%, transparent)' : 'transparent',
        }}
      >
        {hasCh ? (
          <span
            style={{
              width: 16,
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
              fontSize: 9,
              color: 'var(--text-faint)',
              marginRight: 4,
              transition: 'transform 200ms',
              transform: open ? 'rotate(90deg)' : 'rotate(0)',
            }}
          >
            ▶
          </span>
        ) : (
          <span style={{ width: 20, flexShrink: 0 }} />
        )}
        <span style={{ color, fontSize: 10, marginRight: 8 }}>{icon}</span>
        <span
          style={{
            fontSize: type === 'plan' ? 13 : type === 'epic' ? 12 : 11,
            fontWeight: type === 'plan' ? 700 : type === 'epic' ? 600 : 500,
            color: 'var(--foreground)',
            whiteSpace: 'nowrap',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            flex: 1,
          }}
        >
          {label}
        </span>
        {parallelCount !== undefined && (
          <span
            style={{
              marginLeft: 8,
              fontFamily: 'var(--font-mono)',
              fontSize: 8,
              padding: '1px 5px',
              borderRadius: 3,
              background: 'color-mix(in srgb, var(--accent-purple) 12%, transparent)',
              color: 'var(--accent-purple)',
              border: '1px solid color-mix(in srgb, var(--accent-purple) 22%, transparent)',
            }}
          >
            {parallelCount}∥
          </span>
        )}
      </div>
      <div style={{ flex: 1, position: 'relative', padding: '3px 0' }}>
        <AggBar stories={stories} color={color} totalTime={totalTime} />
      </div>
    </div>
  );
}

function AggBar({
  stories,
  color,
  totalTime,
}: {
  stories: SimStory[];
  color: string;
  totalTime: number;
}) {
  if (stories.length === 0) return null;
  const toP = (v: number) => (v / totalTime) * 100;
  const as0 = Math.min(...stories.map((s) => s.actualStart));
  const as1 = Math.max(...stories.map((s) => s.actualStart + s.barWidth));
  const ps1 = Math.max(...stories.map((s) => s.plannedEnd));
  const pr =
    stories.reduce((a, s) => {
      if (s.simStatus === 'done') return a + 100;
      if (s.simStatus === 'running') {
        // live progress approximation
        const elapsed = s.barWidth;
        return a + Math.min(99, (elapsed / s.plannedSec) * 100);
      }
      return a;
    }, 0) / stories.length;
  const co = stories.reduce((a, s) => a + s.cost, 0);
  const anyStress = stories.some((s) => s.isOverrunning);
  const anyLate = stories.some((s) => s.wasLate);
  const disp = as1 - ps1;
  const bc = anyStress
    ? 'var(--destructive)'
    : anyLate || disp > 1
      ? 'var(--amber)'
      : color;
  return (
    <div style={{ position: 'relative', height: 22, marginBottom: 1 }}>
      <div
        style={{
          position: 'absolute',
          left: `${toP(as0)}%`,
          width: `${Math.max(toP(as1 - as0), 0.5)}%`,
          top: 2,
          height: 18,
          borderRadius: 3,
          background: 'var(--background)',
          border: `1px solid color-mix(in srgb, ${bc} 28%, transparent)`,
          overflow: 'hidden',
        }}
      >
        <div
          style={{
            height: '100%',
            width: `${pr}%`,
            background: `linear-gradient(90deg, color-mix(in srgb, ${bc} 28%, transparent), color-mix(in srgb, ${bc} 12%, transparent))`,
            borderRadius: 2,
          }}
        />
        <div
          style={{
            position: 'absolute',
            top: 0,
            right: 8,
            height: '100%',
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            fontFamily: 'var(--font-mono)',
            fontSize: 9,
            color: bc,
            opacity: 0.8,
          }}
        >
          {disp > 1 && (
            <span style={{ color: 'var(--amber)', fontSize: 8 }}>
              +{fmtClock(disp)}
            </span>
          )}
          <span>
            {Math.round(pr)}% · ${co.toFixed(2)}
          </span>
        </div>
      </div>
    </div>
  );
}

function StoryBarRow({
  story,
  totalTime,
  onSelect,
}: {
  story: SimStory;
  totalTime: number;
  onSelect: (s: SimStory) => void;
}) {
  const sc = stColor(story);
  return (
    <div
      style={{
        display: 'flex',
        minHeight: 30,
        borderBottom: '1px solid var(--border)',
      }}
    >
      <div
        style={{
          width: 300,
          minWidth: 300,
          display: 'flex',
          alignItems: 'center',
          paddingLeft: 12 + 3 * 18,
          paddingRight: 10,
          borderRight: '1px solid var(--border)',
        }}
      >
        <span style={{ width: 20, flexShrink: 0 }} />
        <span style={{ color: sc, fontSize: 10, marginRight: 8 }}>●</span>
        <span
          style={{
            fontSize: 11,
            color: 'var(--text-dim)',
            fontFamily: 'var(--font-mono)',
            whiteSpace: 'nowrap',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            flex: 1,
          }}
        >
          {story.label}
        </span>
        {story.isOverrunning && (
          <span
            className="animate-pulse-soft"
            style={{
              marginLeft: 4,
              fontSize: 8,
              color: 'var(--destructive)',
            }}
          >
            ⚠
          </span>
        )}
        {story.displacement > 0.5 && (
          <span
            style={{
              marginLeft: 4,
              fontFamily: 'var(--font-mono)',
              fontSize: 7,
              padding: '1px 4px',
              borderRadius: 3,
              background: 'color-mix(in srgb, var(--amber) 10%, transparent)',
              color: 'var(--amber)',
              border: '1px solid color-mix(in srgb, var(--amber) 22%, transparent)',
              flexShrink: 0,
            }}
          >
            +{Math.round(story.displacement)}s
          </span>
        )}
        <span
          style={{
            marginLeft: 'auto',
            paddingLeft: 6,
            fontFamily: 'var(--font-mono)',
            fontSize: 7,
            padding: '2px 6px',
            borderRadius: 3,
            background: `color-mix(in srgb, ${sc} 10%, transparent)`,
            color: sc,
            border: `1px solid color-mix(in srgb, ${sc} 22%, transparent)`,
            textTransform: 'uppercase',
            letterSpacing: '0.05em',
            flexShrink: 0,
          }}
        >
          {story.simStatus}
        </span>
      </div>
      <div style={{ flex: 1, position: 'relative', padding: '2px 0' }}>
        <StoryBar story={story} totalTime={totalTime} onSelect={onSelect} />
      </div>
    </div>
  );
}

function StoryBar({
  story,
  totalTime,
  onSelect,
}: {
  story: SimStory;
  totalTime: number;
  onSelect: (s: SimStory) => void;
}) {
  const toP = (v: number) => (v / totalTime) * 100;
  const sc = stColor(story);
  const bg = barBg(story);
  const pL = toP(story.plannedStart);
  const pW = toP(story.plannedEnd - story.plannedStart);
  const aL = toP(story.actualStart);
  const aW = toP(story.barWidth);
  const fillPct =
    story.simStatus === 'done'
      ? 100
      : story.simStatus === 'running'
        ? Math.min(100, (story.barWidth / Math.max(story.plannedSec, 1)) * 100)
        : 0;
  const showGhost =
    story.displacement > 0.3 ||
    (story.simStatus !== 'queued' && story.barWidth > story.plannedSec + 0.1);
  const shadow = story.isOverrunning
    ? '0 0 18px color-mix(in srgb, var(--destructive) 30%, transparent)'
    : story.simStatus === 'running'
      ? '0 0 10px color-mix(in srgb, var(--accent-purple) 20%, transparent)'
      : 'none';

  return (
    <div style={{ position: 'relative', height: 28, marginBottom: 1 }}>
      {showGhost && (
        <div
          style={{
            position: 'absolute',
            left: `${pL}%`,
            width: `${pW}%`,
            top: 3,
            height: 22,
            borderRadius: 4,
            border: '1px dashed color-mix(in srgb, var(--border-2) 55%, transparent)',
            pointerEvents: 'none',
            zIndex: 0,
          }}
        />
      )}
      {showGhost && story.displacement > 0.5 && story.simStatus !== 'queued' && (
        <div
          style={{
            position: 'absolute',
            left: `${pL + pW}%`,
            width: `${aL - (pL + pW)}%`,
            top: 14,
            height: 2,
            background:
              'linear-gradient(90deg, color-mix(in srgb, var(--border-2) 40%, transparent), color-mix(in srgb, var(--amber) 60%, transparent))',
            pointerEvents: 'none',
            zIndex: 0,
          }}
        >
          <div
            style={{
              position: 'absolute',
              right: -4,
              top: -3,
              width: 0,
              height: 0,
              borderTop: '4px solid transparent',
              borderBottom: '4px solid transparent',
              borderLeft: '6px solid var(--amber)',
            }}
          />
        </div>
      )}
      <div
        onClick={(e) => {
          e.stopPropagation();
          onSelect(story);
        }}
        onMouseEnter={(e) => (e.currentTarget.style.borderColor = sc)}
        onMouseLeave={(e) =>
          (e.currentTarget.style.borderColor = `color-mix(in srgb, ${sc} 28%, transparent)`)
        }
        style={{
          position: 'absolute',
          left: `${aL}%`,
          width: `${Math.max(aW, 0.2)}%`,
          top: 3,
          height: 22,
          borderRadius: 4,
          background: 'var(--surface)',
          border: `1px solid color-mix(in srgb, ${sc} 28%, transparent)`,
          overflow: 'hidden',
          boxShadow: shadow,
          cursor: 'pointer',
          zIndex: 1,
          transition: 'border-color 200ms, box-shadow 200ms',
        }}
      >
        <div
          style={{
            height: '100%',
            width: `${fillPct}%`,
            background: bg,
            borderRadius: 3,
            transition: 'background 400ms',
          }}
        />
        <div
          style={{
            position: 'absolute',
            top: 0,
            left: 8,
            right: 4,
            height: '100%',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            fontSize: 10,
            fontFamily: 'var(--font-mono)',
            color: 'var(--foreground)',
            pointerEvents: 'none',
            gap: 4,
          }}
        >
          <span
            style={{
              opacity: 0.9,
              whiteSpace: 'nowrap',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              display: 'flex',
              alignItems: 'center',
              gap: 4,
            }}
          >
            {story.label}
            {story.isOverrunning && (
              <span
                className="animate-pulse-soft"
                style={{ fontSize: 9, color: 'var(--destructive-foreground)' }}
              >
                ⚠
              </span>
            )}
          </span>
          <span style={{ opacity: 0.55, flexShrink: 0, fontSize: 9 }}>
            {story.simStatus !== 'queued' && (
              <>
                {fmtClock(story.barWidth)} · ${story.cost.toFixed(2)}
              </>
            )}
          </span>
        </div>
      </div>
    </div>
  );
}

// ── Drawer ───────────────────────────────────────────────────────────

function GanttDrawer({
  story,
  onClose,
}: {
  story: SimStory;
  onClose: () => void;
}) {
  const router = useRouter();
  const params = useSearchParams();
  const planId = params.get('planId');
  const drawerRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const sc = stColor(story);
  const meta = STORY_STATUS_META[story.status];
  const durRatio = story.actualDur != null ? story.actualDur / story.plannedSec : null;
  const isOver =
    story.simStatus === 'done' ? story.wasLate : story.isOverrunning;

  function openInHierarchy() {
    if (!planId) return;
    const next = new URLSearchParams(params.toString());
    next.set('tab', 'hierarchy');
    router.replace(`/labs/?${next.toString()}`);
    onClose();
  }

  return (
    <div
      onClick={onClose}
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(0,0,0,0.55)',
        zIndex: 300,
      }}
    >
      <div
        ref={drawerRef}
        onClick={(e) => e.stopPropagation()}
        style={{
          position: 'absolute',
          top: 0,
          right: 0,
          bottom: 0,
          width: 480,
          background: 'var(--bg-elev)',
          borderLeft: '1px solid var(--border)',
          display: 'flex',
          flexDirection: 'column',
          overflow: 'hidden',
          boxShadow: '-20px 0 60px rgba(0,0,0,0.6)',
        }}
      >
        <div
          style={{
            padding: '16px 20px',
            borderBottom: '1px solid var(--border)',
            display: 'flex',
            alignItems: 'flex-start',
            gap: 12,
          }}
        >
          <span
            style={{
              background: sc,
              width: 8,
              height: 8,
              borderRadius: '50%',
              marginTop: 7,
              boxShadow: `0 0 10px color-mix(in srgb, ${sc} 50%, transparent)`,
              display: 'inline-block',
            }}
          />
          <div style={{ flex: 1, minWidth: 0 }}>
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                marginBottom: 4,
                flexWrap: 'wrap',
              }}
            >
              <span
                style={{
                  fontFamily: 'var(--font-mono)',
                  fontSize: 11,
                  color: sc,
                  fontWeight: 700,
                }}
              >
                {story.id.slice(0, 10)}
              </span>
              <span
                style={{
                  fontFamily: 'var(--font-mono)',
                  fontSize: 9,
                  color: 'var(--text-faint)',
                  padding: '1px 5px',
                  borderRadius: 3,
                  background: 'var(--surface)',
                  border: '1px solid var(--border)',
                }}
              >
                {story.epicLabel}
              </span>
              <span
                style={{
                  fontFamily: 'var(--font-mono)',
                  fontSize: 9,
                  color: 'var(--accent-purple)',
                  padding: '1px 5px',
                  borderRadius: 3,
                  background: 'color-mix(in srgb, var(--accent-purple) 10%, transparent)',
                  border: '1px solid color-mix(in srgb, var(--accent-purple) 22%, transparent)',
                }}
              >
                {story.waveId}
              </span>
              <span
                style={{
                  fontFamily: 'var(--font-mono)',
                  fontSize: 9,
                  color: sc,
                  textTransform: 'uppercase',
                  letterSpacing: '0.08em',
                  marginLeft: 'auto',
                }}
              >
                {meta.label}
              </span>
            </div>
            <div
              style={{
                fontSize: 16,
                fontWeight: 600,
                color: 'var(--foreground)',
                textWrap: 'pretty',
                lineHeight: 1.3,
              }}
            >
              {story.label}
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            style={{
              color: 'var(--text-mute)',
              fontSize: 18,
              flexShrink: 0,
              padding: 4,
              background: 'transparent',
              border: 'none',
              cursor: 'pointer',
            }}
          >
            ✕
          </button>
        </div>

        <div style={{ padding: 20, overflow: 'auto', flex: 1 }}>
          <p
            style={{
              fontSize: 12.5,
              color: 'var(--text-dim)',
              lineHeight: 1.6,
              marginBottom: 18,
              textWrap: 'pretty',
            }}
          >
            {story.desc}
          </p>

          {/* Estimate accuracy */}
          <DrawerLabel>Estimate accuracy</DrawerLabel>
          <div
            style={{
              height: 10,
              background: 'var(--border)',
              borderRadius: 5,
              overflow: 'hidden',
              display: 'flex',
            }}
          >
            <div
              style={{
                width: `${Math.min(100, (story.plannedSec / Math.max(story.barWidth, story.plannedSec)) * 100)}%`,
                background:
                  'linear-gradient(90deg, color-mix(in srgb, var(--success) 70%, transparent), var(--success))',
              }}
            />
            <div
              style={{
                flex: 1,
                background: story.isOverrunning
                  ? 'linear-gradient(90deg, color-mix(in srgb, var(--destructive) 80%, transparent), var(--destructive))'
                  : story.wasLate
                    ? 'linear-gradient(90deg, color-mix(in srgb, var(--amber) 70%, transparent), var(--amber))'
                    : 'transparent',
              }}
            />
          </div>
          <div
            style={{
              fontFamily: 'var(--font-mono)',
              fontSize: 10,
              color: 'var(--text-mute)',
              marginTop: 4,
              display: 'flex',
              justifyContent: 'space-between',
              marginBottom: 18,
            }}
          >
            <span>planned {fmtClock(story.plannedSec)}</span>
            <span style={{ color: isOver ? 'var(--destructive)' : 'var(--text-mute)' }}>
              {story.actualDur != null
                ? `actual ${fmtClock(story.actualDur)}`
                : story.simStatus === 'running'
                  ? `${fmtClock(story.barWidth)} elapsed…`
                  : 'not started'}
            </span>
          </div>

          <div
            style={{
              display: 'grid',
              gridTemplateColumns: '1fr 1fr',
              gap: 8,
              marginBottom: 18,
            }}
          >
            {[
              { l: 'Status', v: meta.label, c: sc },
              { l: 'Story points', v: `${story.sp} SP`, c: 'var(--foreground)' },
              { l: 'Planned', v: fmtClock(story.plannedSec), c: 'var(--text-mute)' },
              {
                l: 'Actual',
                v:
                  story.actualDur != null
                    ? fmtClock(story.actualDur)
                    : story.simStatus === 'running'
                      ? `${fmtClock(story.barWidth)} so far`
                      : '—',
                c: isOver ? 'var(--amber)' : 'var(--foreground)',
              },
              {
                l: 'Progress',
                v: `${Math.round(story.progress)}%`,
                c: 'var(--accent-purple)',
              },
              { l: 'Cost', v: fmtCost(story.cost), c: 'var(--amber)' },
              {
                l: 'Displaced',
                v: story.displacement > 0.5 ? `+${fmtClock(story.displacement)}` : 'None',
                c: story.displacement > 0.5 ? 'var(--amber)' : 'var(--success)',
              },
              {
                l: 'Overrun',
                v: durRatio
                  ? `${durRatio.toFixed(2)}×`
                  : story.isOverrunning
                    ? 'active'
                    : '—',
                c: isOver ? 'var(--destructive)' : 'var(--text-mute)',
              },
            ].map((m) => (
              <div
                key={m.l}
                style={{
                  padding: '8px 12px',
                  background: 'var(--surface)',
                  border: '1px solid var(--border)',
                  borderRadius: 6,
                }}
              >
                <div
                  style={{
                    fontFamily: 'var(--font-mono)',
                    fontSize: 8,
                    color: 'var(--text-faint)',
                    textTransform: 'uppercase',
                    letterSpacing: '0.1em',
                    marginBottom: 3,
                  }}
                >
                  {m.l}
                </div>
                <div
                  style={{
                    fontFamily: 'var(--font-mono)',
                    fontSize: 13,
                    color: m.c,
                    fontWeight: 600,
                  }}
                >
                  {m.v}
                </div>
              </div>
            ))}
          </div>

          {story.criteria.length > 0 && (
            <div style={{ marginBottom: 18 }}>
              <DrawerLabel>Acceptance criteria</DrawerLabel>
              {story.criteria.map((c, i) => (
                <div
                  key={i}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 8,
                    fontSize: 12,
                    padding: '4px 0',
                  }}
                >
                  <span
                    style={{
                      width: 14,
                      height: 14,
                      borderRadius: 3,
                      border: `1px solid ${c.done ? 'var(--success)' : 'var(--border-2)'}`,
                      background: c.done
                        ? 'color-mix(in srgb, var(--success) 8%, transparent)'
                        : 'transparent',
                      display: 'inline-flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      color: 'var(--success)',
                      fontSize: 10,
                    }}
                  >
                    {c.done ? '✓' : ''}
                  </span>
                  <span
                    style={{
                      color: c.done ? 'var(--text-dim)' : 'var(--foreground)',
                    }}
                  >
                    {c.text}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>

        <div
          style={{
            padding: '12px 20px',
            borderTop: '1px solid var(--border)',
            display: 'flex',
            gap: 8,
          }}
        >
          <button
            type="button"
            onClick={openInHierarchy}
            style={{
              fontSize: 12,
              padding: '8px 14px',
              borderRadius: 5,
              background: 'color-mix(in srgb, var(--success) 10%, transparent)',
              border: '1px solid var(--success)',
              color: 'var(--success)',
              fontWeight: 600,
              cursor: 'pointer',
            }}
          >
            Open in Hierarchy
          </button>
        </div>
      </div>
    </div>
  );
}

function DrawerLabel({ children }: { children: React.ReactNode }) {
  return (
    <div
      style={{
        fontFamily: 'var(--font-mono)',
        fontSize: 8,
        color: 'var(--text-faint)',
        textTransform: 'uppercase',
        letterSpacing: '0.12em',
        marginBottom: 6,
      }}
    >
      {children}
    </div>
  );
}
