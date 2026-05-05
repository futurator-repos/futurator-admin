'use client';
import { useMemo, useRef, useState, useEffect } from 'react';
import { usePlansList } from '@/hooks/use-plans';
import { useOfficeStore } from '../store';
import { paletteForPlanId } from '../plan-palette';
import { KANBAN_COLUMNS, type KanbanColumn, type KanbanStory } from '../types';

// ── Shared sticky-note palette — used by both the overlay cards and the
// in-world whiteboard stickies so they visually match. Color is chosen
// deterministically from the story ID so a sticky always renders the same
// hue wherever it appears.

export const STICKY_PALETTE = [
  { bg: '#ffd166', fg: '#3a2a10' },
  { bg: '#ef476f', fg: '#2a0818' },
  { bg: '#06d6a0', fg: '#08372a' },
  { bg: '#118ab2', fg: '#f0f9ff' },
  { bg: '#fcbf49', fg: '#3a2a10' },
  { bg: '#c77dff', fg: '#2a0a4a' },
  { bg: '#ffadad', fg: '#2a0a0a' },
  { bg: '#a0c4ff', fg: '#0a1a3a' },
] as const;

export function stickyHueFor(storyId: string): (typeof STICKY_PALETTE)[number] {
  let h = 0;
  for (let i = 0; i < storyId.length; i++) h = (h * 31 + storyId.charCodeAt(i)) & 0xffff;
  return STICKY_PALETTE[h % STICKY_PALETTE.length];
}

export function stickyTiltFor(storyId: string): number {
  let h = 0;
  for (let i = 0; i < storyId.length; i++) h = (h * 37 + storyId.charCodeAt(i)) & 0xffff;
  // −3°..+3° in degrees
  return ((h % 7) - 3) * 1.1;
}

const COLUMN_LABEL: Record<KanbanColumn, string> = {
  backlog: 'Backlog',
  queued: 'Queued',
  in_progress: 'In Progress',
  in_review: 'In Review',
  done: 'Done',
};

const COLUMN_TINT: Record<KanbanColumn, string> = {
  backlog: 'from-slate-950/70 to-slate-900/50',
  queued: 'from-amber-950/60 to-amber-900/30',
  in_progress: 'from-blue-950/60 to-blue-900/30',
  in_review: 'from-violet-950/60 to-violet-900/30',
  done: 'from-emerald-950/60 to-emerald-900/30',
};

const COLUMN_ACCENT: Record<KanbanColumn, string> = {
  backlog: 'text-slate-300',
  queued: 'text-amber-300',
  in_progress: 'text-blue-300',
  in_review: 'text-violet-300',
  done: 'text-emerald-300',
};

export function KanbanBoard() {
  const open = useOfficeStore((s) => s.kanbanOpen);
  const setKanbanOpen = useOfficeStore((s) => s.setKanbanOpen);
  const stories = useOfficeStore((s) => s.kanbanStories);
  const selectedPlanIds = useOfficeStore((s) => s.selectedKanbanPlanIds);
  const toggleKanbanPlan = useOfficeStore((s) => s.toggleKanbanPlan);
  const clearKanbanPlans = useOfficeStore((s) => s.clearKanbanPlans);
  const { data: plans } = usePlansList();

  // Only show plans that actually have stories on the board right now.
  // Legacy epics with no planId fall under a synthetic "Unassigned" bucket
  // so they remain filterable instead of silently vanishing.
  const planOptions = useMemo(() => {
    const storyPlanIds = new Set<string | null>();
    for (const s of stories) storyPlanIds.add(s.planId);
    const nameById = new Map<string, string>();
    for (const p of plans ?? []) {
      nameById.set(p.planId, p.displayName || p.name);
    }
    const list: { id: string; label: string; isUnassigned: boolean }[] = [];
    for (const planId of storyPlanIds) {
      if (planId === null) {
        list.push({ id: '__unassigned__', label: 'Unassigned', isUnassigned: true });
      } else {
        list.push({
          id: planId,
          label: nameById.get(planId) ?? planId.slice(0, 8),
          isUnassigned: false,
        });
      }
    }
    list.sort((a, b) => {
      if (a.isUnassigned) return 1;
      if (b.isUnassigned) return -1;
      return a.label.localeCompare(b.label);
    });
    return list;
  }, [stories, plans]);

  const byColumn = useMemo(() => {
    const groups: Record<KanbanColumn, KanbanStory[]> = {
      backlog: [],
      queued: [],
      in_progress: [],
      in_review: [],
      done: [],
    };
    const filtered =
      selectedPlanIds.length === 0
        ? stories
        : stories.filter((s) => {
            const key = s.planId ?? '__unassigned__';
            return selectedPlanIds.includes(key);
          });
    for (const s of filtered) groups[s.column].push(s);
    return groups;
  }, [stories, selectedPlanIds]);

  // Plan-name lookup for kanban card chips.
  const planNameById = useMemo(() => {
    const map = new Map<string, string>();
    for (const p of plans ?? []) map.set(p.planId, p.displayName || p.name);
    return map;
  }, [plans]);

  // Overlay is ONLY shown when the user clicks the 3D whiteboard. No
  // floating "open kanban" button — the board is the entry point.
  if (!open) return null;

  const showAll = selectedPlanIds.length === 0;

  return (
    <div className="pointer-events-auto absolute inset-x-3 top-3 bottom-3 flex flex-col rounded-lg border border-border/60 bg-black/75 backdrop-blur-md">
      <div className="flex items-center justify-between border-b border-border/60 px-4 py-2 gap-3">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-[12px] font-semibold text-white shrink-0">Kanban</span>
          <PlanMultiSelect
            options={planOptions}
            selectedIds={selectedPlanIds}
            showAll={showAll}
            onToggle={toggleKanbanPlan}
            onClear={clearKanbanPlans}
          />
        </div>
        <button
          type="button"
          onClick={() => setKanbanOpen(false)}
          className="text-[11px] text-white/70 hover:text-white shrink-0"
        >
          Close ✕
        </button>
      </div>

      <div className="grid flex-1 grid-cols-5 gap-2 overflow-hidden p-2">
        {KANBAN_COLUMNS.map((col) => (
          <div
            key={col}
            className={`flex flex-col overflow-hidden rounded-md border border-border/40 bg-gradient-to-b ${COLUMN_TINT[col]}`}
          >
            <div className="flex items-center justify-between border-b border-border/40 px-2.5 py-1.5">
              <span
                className={`text-[11px] font-semibold uppercase tracking-wide ${COLUMN_ACCENT[col]}`}
              >
                {COLUMN_LABEL[col]}
              </span>
              <span className="text-[10px] text-white/50">{byColumn[col].length}</span>
            </div>
            <div className="flex-1 space-y-2 overflow-y-auto p-2">
              {byColumn[col].map((s) => (
                <KanbanCard
                  key={`${s.epicId}-${s.storyId}`}
                  story={s}
                  planName={
                    showAll && s.planId ? (planNameById.get(s.planId) ?? null) : null
                  }
                />
              ))}
              {byColumn[col].length === 0 && (
                <div className="py-4 text-center text-[10px] text-white/30">—</div>
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function KanbanCard({
  story,
  planName,
}: {
  story: KanbanStory;
  planName: string | null;
}) {
  const hue = stickyHueFor(story.storyId);
  const tilt = stickyTiltFor(story.storyId);
  // Epic B.6: retry treatment — orange ring at attempt 2, red ring at
  // attempt 3. Failed always wins with a bold red ring.
  const retryRing = story.failed
    ? 'ring-2 ring-red-500/80'
    : story.attempt >= 3
      ? 'ring-2 ring-red-400/70'
      : story.attempt === 2
        ? 'ring-2 ring-orange-400/70'
        : '';
  return (
    <div
      style={{
        background: hue.bg,
        color: hue.fg,
        transform: `rotate(${tilt}deg)`,
        boxShadow: '0 4px 10px rgba(0, 0, 0, 0.45), inset 0 1px 0 rgba(255, 255, 255, 0.15)',
      }}
      className={`rounded-[3px] p-2 transition-transform hover:z-10 hover:scale-[1.03] ${retryRing}`}
    >
      <div className="flex items-start justify-between gap-1">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1 text-[9px] font-mono opacity-70">
            <span className="truncate">{story.storyId.slice(0, 8)}</span>
            {story.wave !== null && (
              <span className="rounded bg-black/20 px-1 font-semibold">W{story.wave}</span>
            )}
            {story.attempt > 1 && (
              <span className="rounded bg-black/30 px-1 font-semibold">try {story.attempt}</span>
            )}
          </div>
          <div
            className="mt-1 line-clamp-3 text-[11px] font-semibold leading-snug"
            title={story.title}
          >
            {story.title}
          </div>
        </div>
      </div>
      {planName && (
        <div className="mt-1.5 truncate text-[9px] font-semibold uppercase tracking-wide opacity-60">
          {planName}
        </div>
      )}
      {story.assigneeName && (
        <div className="mt-1.5 flex items-center gap-1 text-[10px] opacity-80">
          <span>✎</span>
          <span>{story.assigneeName}</span>
        </div>
      )}
      {/* Attempt dots — 3 slots, filled per attempt number, capped at 3. */}
      {story.attempt > 1 && (
        <div
          className="mt-1.5 flex items-center gap-1 text-[9px] opacity-80"
          aria-label={`Attempt ${story.attempt} of 3`}
        >
          {[1, 2, 3].map((n) => (
            <span
              key={n}
              className="inline-block h-1.5 w-1.5 rounded-full"
              style={{
                backgroundColor:
                  n <= story.attempt
                    ? n === 3
                      ? '#dc2626'
                      : n === 2
                        ? '#f97316'
                        : 'currentColor'
                    : 'rgba(0,0,0,0.15)',
              }}
            />
          ))}
          <span className="ml-1 font-semibold uppercase tracking-wide">
            retry {story.attempt - 1}/2
          </span>
        </div>
      )}
      {story.failed && (
        <div className="mt-1 text-[10px] font-bold uppercase tracking-wide text-red-600">
          ✗ Failed
        </div>
      )}
    </div>
  );
}

// ── Plan multi-select ──
// Pill button that reveals a checkbox popover. Empty selection = "All
// plans"; toggling a plan adds/removes it. Plan names come from the
// `/plans` list — unassigned legacy epics (no planId) get a synthetic
// "Unassigned" row so they remain filterable.

interface PlanOption {
  id: string;
  label: string;
  isUnassigned: boolean;
}

function PlanMultiSelect({
  options,
  selectedIds,
  showAll,
  onToggle,
  onClear,
}: {
  options: PlanOption[];
  selectedIds: string[];
  showAll: boolean;
  onToggle: (id: string) => void;
  onClear: () => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement | null>(null);

  // Close on outside click.
  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (!ref.current) return;
      if (!ref.current.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener('mousedown', handler);
    return () => window.removeEventListener('mousedown', handler);
  }, [open]);

  const summary = useMemo(() => {
    if (showAll) return `All plans (${options.length})`;
    if (selectedIds.length === 1) {
      const o = options.find((x) => x.id === selectedIds[0]);
      return o?.label ?? '1 plan';
    }
    return `${selectedIds.length} plans`;
  }, [showAll, selectedIds, options]);

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-1.5 rounded border border-border/60 bg-black/40 px-2 py-0.5 text-[11px] text-white/80 hover:border-border hover:text-white"
      >
        <span className="max-w-[180px] truncate">{summary}</span>
        <span className="opacity-60">▾</span>
      </button>

      {/* Active selection chips — only shown when filtering to ≥1 plan.
          Each chip is tinted with the plan's shared palette color so the
          user sees the same hue here and on the in-scene desk tags. */}
      {!showAll && (
        <div className="mt-1 flex flex-wrap gap-1">
          {selectedIds.map((id) => {
            const o = options.find((x) => x.id === id);
            if (!o) return null;
            const palette = paletteForPlanId(o.isUnassigned ? null : id);
            return (
              <button
                key={id}
                type="button"
                onClick={() => onToggle(id)}
                className={`flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] hover:brightness-125 ${palette.borderClass} ${palette.bgClass} ${palette.textClass}`}
                title="Remove plan from filter"
              >
                <span className="max-w-[140px] truncate">{o.label}</span>
                <span className="opacity-70">✕</span>
              </button>
            );
          })}
          <button
            type="button"
            onClick={onClear}
            className="rounded-full px-2 py-0.5 text-[10px] text-white/50 hover:text-white/90"
          >
            clear
          </button>
        </div>
      )}

      {open && (
        <div className="absolute left-0 top-full z-50 mt-1 min-w-[240px] max-h-[320px] overflow-y-auto rounded-md border border-border/60 bg-black/90 p-1 backdrop-blur-md shadow-xl">
          <button
            type="button"
            onClick={() => {
              onClear();
            }}
            className={`flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-[11px] hover:bg-white/5 ${
              showAll ? 'text-white' : 'text-white/70'
            }`}
          >
            <span
              className={`inline-flex h-3 w-3 items-center justify-center rounded-sm border ${
                showAll ? 'border-blue-400 bg-blue-500/80' : 'border-white/30'
              }`}
            >
              {showAll && <span className="text-[9px] text-white">✓</span>}
            </span>
            All plans
            <span className="ml-auto text-[10px] text-white/40">{options.length}</span>
          </button>
          <div className="my-1 border-t border-border/40" />
          {options.length === 0 && (
            <div className="px-2 py-2 text-[11px] italic text-white/40">No stories yet</div>
          )}
          {options.map((o) => {
            const checked = selectedIds.includes(o.id);
            const palette = paletteForPlanId(o.isUnassigned ? null : o.id);
            return (
              <button
                key={o.id}
                type="button"
                onClick={() => onToggle(o.id)}
                className={`flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-[11px] hover:bg-white/5 ${
                  checked ? 'text-white' : 'text-white/70'
                }`}
              >
                <span
                  className={`inline-flex h-3 w-3 items-center justify-center rounded-sm border ${
                    checked ? 'border-blue-400 bg-blue-500/80' : 'border-white/30'
                  }`}
                >
                  {checked && <span className="text-[9px] text-white">✓</span>}
                </span>
                {/* Plan color swatch — matches the in-scene desk tag tint. */}
                <span
                  className="inline-block h-2.5 w-2.5 shrink-0 rounded-full"
                  style={{ backgroundColor: palette.hex }}
                  title={`Plan color: ${palette.name}`}
                />
                <span className="min-w-0 flex-1 truncate">{o.label}</span>
                {o.isUnassigned && (
                  <span className="text-[9px] uppercase tracking-wide text-white/30">legacy</span>
                )}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
