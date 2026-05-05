'use client';
import { useMemo } from 'react';
import { CAST_BY_ID } from '../cast';
import { useOfficeStore } from '../store';
import type { PersonaActivity, PersonaRole } from '../types';

const ROLE_PILL: Record<PersonaRole, { label: string; className: string }> = {
  pm: {
    label: 'PM',
    className: 'bg-violet-500/20 text-violet-200 border-violet-400/40',
  },
  orchestrator: {
    label: 'ORCHESTRATOR',
    className: 'bg-amber-500/20 text-amber-200 border-amber-400/40',
  },
  developer: {
    label: 'DEVELOPER',
    className: 'bg-blue-500/20 text-blue-200 border-blue-400/40',
  },
  reviewer: {
    label: 'REVIEWER',
    className: 'bg-rose-500/20 text-rose-200 border-rose-400/40',
  },
  tester: {
    label: 'TESTER',
    className: 'bg-cyan-500/20 text-cyan-200 border-cyan-400/40',
  },
};

const ACTIVITY_LABEL: Record<PersonaActivity, string> = {
  idle: 'Idle',
  walking: 'Walking',
  sitting: 'Sitting (working)',
  standing: 'Standing',
  pointing: 'Pointing at whiteboard',
  drinking: 'Grabbing coffee',
  cheering: 'Celebrating',
  dejected: 'Frustrated',
};

export function CharacterPanel() {
  const selectedId = useOfficeStore((s) => s.selectedCharacterId);
  const selectCharacter = useOfficeStore((s) => s.selectCharacter);
  const runtime = useOfficeStore((s) =>
    selectedId ? s.runtimes[selectedId] : null,
  );
  const assignment = useOfficeStore((s) =>
    selectedId ? s.assignmentByCharacter[selectedId] : null,
  );
  const assignmentDetail = useOfficeStore((s) =>
    assignment ? s.assignmentsByStory[assignment] : undefined,
  );
  const kanbanStories = useOfficeStore((s) => s.kanbanStories);
  const bubbles = useOfficeStore((s) =>
    selectedId ? s.bubbles[selectedId] : undefined,
  );
  const eventLog = useOfficeStore((s) => s.eventLog);

  const recentEvents = useMemo(() => {
    if (!selectedId) return [];
    const name = CAST_BY_ID[selectedId]?.name;
    return eventLog.filter((e) => e.characterName === name).slice(0, 12);
  }, [eventLog, selectedId]);

  const currentStory = useMemo(() => {
    if (!assignmentDetail) return null;
    return (
      kanbanStories.find(
        (s) =>
          s.storyId === assignmentDetail.storyId &&
          s.epicId === assignmentDetail.epicId,
      ) ?? null
    );
  }, [assignmentDetail, kanbanStories]);

  if (!selectedId || !runtime) return null;
  const persona = CAST_BY_ID[selectedId];
  if (!persona) return null;
  const pill = ROLE_PILL[persona.role];

  return (
    <div className="pointer-events-auto absolute right-3 top-3 bottom-3 w-[340px] overflow-hidden rounded-lg border border-border/60 bg-black/80 backdrop-blur-md">
      <div className="flex items-center justify-between border-b border-border/60 px-4 py-2.5">
        <div className="flex items-center gap-2.5">
          <div className="text-[14px] font-semibold text-white">{persona.name}</div>
          <span
            className={`inline-flex rounded border px-1.5 py-0.5 text-[9px] font-bold tracking-wider ${pill.className}`}
          >
            {pill.label}
          </span>
        </div>
        <button
          type="button"
          onClick={() => selectCharacter(null)}
          className="text-[11px] text-white/70 hover:text-white"
        >
          ✕
        </button>
      </div>

      <div className="space-y-3 p-3">
        {/* Current state */}
        <section>
          <SectionLabel>Current state</SectionLabel>
          <div className="mt-1.5 grid grid-cols-2 gap-x-3 gap-y-1 text-[11px]">
            <Row label="Activity" value={ACTIVITY_LABEL[runtime.activity]} />
            <Row
              label="Presence"
              value={runtime.presence}
              tone={runtime.presence === 'onstage' ? 'ok' : 'dim'}
            />
            {runtime.seat && (
              <Row
                label="At"
                value={`${runtime.seat.kind} · ${runtime.seat.slot}`}
              />
            )}
            {runtime.target && (
              <Row
                label="Walking to"
                value={
                  runtime.target.seat
                    ? `${runtime.target.seat.kind} · ${runtime.target.seat.slot}`
                    : 'floor'
                }
              />
            )}
          </div>
        </section>

        {/* Current story */}
        <section>
          <SectionLabel>Current story</SectionLabel>
          {currentStory ? (
            <div className="mt-1.5 rounded-md border border-border/40 bg-white/5 p-2.5 text-[11px] text-white/90">
              <div className="flex items-center gap-1.5 text-[10px] font-mono text-white/50">
                <span className="truncate">{currentStory.storyId.slice(0, 12)}</span>
                {currentStory.wave !== null && (
                  <span className="rounded bg-white/10 px-1">W{currentStory.wave}</span>
                )}
                {currentStory.attempt > 1 && (
                  <span className="rounded bg-amber-500/20 px-1 text-amber-200">
                    try {currentStory.attempt}
                  </span>
                )}
              </div>
              <div className="mt-1 font-medium leading-snug">{currentStory.title}</div>
              <div className="mt-1.5 flex items-center gap-2 text-[10px] text-white/60">
                <span className="truncate">{currentStory.epicTitle}</span>
                <span>·</span>
                <span className="uppercase tracking-wide">{currentStory.column.replace('_', ' ')}</span>
                {currentStory.failed && (
                  <span className="ml-auto rounded bg-red-500/20 px-1 text-red-300">failed</span>
                )}
              </div>
            </div>
          ) : (
            <div className="mt-1 text-[11px] text-white/40 italic">
              Not assigned to a story right now
            </div>
          )}
        </section>

        {/* Live bubbles */}
        {bubbles && bubbles.length > 0 && (
          <section>
            <SectionLabel>Live thoughts</SectionLabel>
            <ul className="mt-1.5 space-y-1">
              {bubbles
                .slice()
                .reverse()
                .map((b) => (
                  <li
                    key={b.id}
                    className="flex items-start gap-1.5 rounded-md border border-border/30 bg-white/5 px-2 py-1 text-[11px] text-white/85"
                  >
                    <span>{b.emoji}</span>
                    <span className="flex-1">{b.text}</span>
                  </li>
                ))}
            </ul>
          </section>
        )}

        {/* Recent activity */}
        <section>
          <SectionLabel>Recent activity</SectionLabel>
          {recentEvents.length === 0 ? (
            <div className="mt-1 text-[11px] text-white/40 italic">No recent events</div>
          ) : (
            <ul className="mt-1.5 max-h-[220px] space-y-1 overflow-y-auto pr-1">
              {recentEvents.map((e) => (
                <li
                  key={e.id}
                  className="flex items-start gap-1.5 text-[11px] text-white/80"
                >
                  <span className="shrink-0 w-8 text-right text-[9px] text-white/40">
                    {e.time.slice(0, 8)}
                  </span>
                  <span className="shrink-0">{e.emoji}</span>
                  <span className="flex-1 break-words">{e.message}</span>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </div>
  );
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <div className="text-[10px] font-semibold uppercase tracking-[0.15em] text-white/40">
      {children}
    </div>
  );
}

function Row({
  label,
  value,
  tone = 'default',
}: {
  label: string;
  value: string;
  tone?: 'default' | 'ok' | 'dim';
}) {
  const toneClass =
    tone === 'ok' ? 'text-emerald-300' : tone === 'dim' ? 'text-white/50' : 'text-white/85';
  return (
    <>
      <div className="text-white/50">{label}</div>
      <div className={`truncate ${toneClass}`}>{value}</div>
    </>
  );
}
