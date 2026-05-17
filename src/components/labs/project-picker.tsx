'use client';
import { useMemo, useState, useRef, useEffect } from 'react';
import { formatDistanceToNow } from 'date-fns';
import { ChevronDown, Search, Plus, Check } from 'lucide-react';
import {
  useLabsStore,
  epicStatusToStage,
  normalizeAppName,
  VERSION_STAGES,
} from '@/stores/labs-store';
import { useEpicList, type EpicSummary } from '@/hooks/use-epic-workflow';
import { usePartyProjects } from '@/hooks/use-party-projects';
import type { BmadStatus, PartyProject } from '@/types/party';

interface PickerRow {
  appName: string;
  displayName: string;
  path: string;
  epic?: EpicSummary;
  bmad?: PartyProject;
}

const BMAD_BADGE: Record<BmadStatus, { label: string; className: string }> = {
  HEALTHY: {
    label: 'Healthy',
    className: 'text-green-400 border-green-900/60 bg-green-900/30',
  },
  DRIFTED: {
    label: 'Drifted',
    className: 'text-yellow-400 border-yellow-900/60 bg-yellow-900/30',
  },
  INSTALLING: {
    label: 'Installing…',
    className: 'text-blue-400 border-blue-900/60 bg-blue-900/30 animate-pulse',
  },
  MISSING: {
    label: 'Missing',
    className: 'text-muted-foreground border-border bg-muted/30',
  },
  FAILED: {
    label: 'Failed',
    className: 'text-red-400 border-red-900/60 bg-red-900/30',
  },
  CORRUPTED: {
    label: 'Corrupted',
    className: 'text-red-400 border-red-900/60 bg-red-900/30',
  },
  REFRESHING: {
    label: 'Refreshing…',
    className: 'text-blue-400 border-blue-900/60 bg-blue-900/30 animate-pulse',
  },
};

const STAGE_COLOR: Record<string, string> = {
  concept: 'text-slate-300 bg-slate-700/40 border-slate-600/60',
  development: 'text-amber-300 bg-amber-900/30 border-amber-800/50',
  review: 'text-purple-300 bg-purple-900/30 border-purple-800/50',
  deploy: 'text-blue-300 bg-blue-900/30 border-blue-800/50',
  delivered: 'text-green-300 bg-green-900/30 border-green-800/50',
};

function shortenPath(p: string): string {
  return p.replace(/^\/home\/ubuntu\//, '~/');
}

function statusDotColor(row: PickerRow): string {
  if (row.bmad?.bmadStatus === 'HEALTHY') return 'var(--success)';
  if (row.bmad?.bmadStatus === 'INSTALLING') return '#60a5fa';
  if (row.bmad?.bmadStatus === 'DRIFTED') return '#facc15';
  if (row.bmad?.bmadStatus === 'FAILED' || row.bmad?.bmadStatus === 'CORRUPTED') return '#f87171';
  if (row.epic) {
    const stage = epicStatusToStage(row.epic.status);
    if (stage === 'delivered') return '#60a5fa';
    if (stage === 'deploy') return 'var(--success)';
    if (stage === 'development') return '#fbbf24';
    if (stage === 'review') return '#c084fc';
  }
  return '#6b7280';
}

export function ProjectPicker() {
  const { activeAppName, setActiveAppName } = useLabsStore();
  const { data: epics } = useEpicList();
  const { data: partyData } = usePartyProjects();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [showNew, setShowNew] = useState(false);
  const [newName, setNewName] = useState('');
  const rootRef = useRef<HTMLDivElement | null>(null);

  const rows: PickerRow[] = useMemo(() => {
    const map = new Map<string, PickerRow>();
    for (const epic of epics || []) {
      const app = normalizeAppName(epic.appName);
      map.set(app, {
        appName: app,
        displayName: epic.title?.replace(/^Epic:\s*/i, '') || epic.appName,
        path: epic.workingDir || `/home/ubuntu/projects/${app}`,
        epic,
      });
    }
    for (const proj of partyData?.projects || []) {
      const app = normalizeAppName(proj.projectId);
      const existing = map.get(app);
      if (existing) {
        existing.bmad = proj;
      } else {
        map.set(app, {
          appName: app,
          displayName: proj.projectId,
          path: proj.path,
          bmad: proj,
        });
      }
    }
    return [...map.values()].sort((a, b) => {
      const aHas = a.epic ? 0 : 1;
      const bHas = b.epic ? 0 : 1;
      if (aHas !== bHas) return aHas - bHas;
      return a.displayName.localeCompare(b.displayName);
    });
  }, [epics, partyData?.projects]);

  const filtered = useMemo(() => {
    if (!query.trim()) return rows;
    const q = query.toLowerCase();
    return rows.filter(
      (r) =>
        r.appName.includes(q) ||
        r.displayName.toLowerCase().includes(q) ||
        r.path.toLowerCase().includes(q),
    );
  }, [rows, query]);

  const active = rows.find((r) => r.appName === activeAppName) || null;
  const healthyCount = rows.filter((r) => r.bmad?.bmadStatus === 'HEALTHY').length;

  useEffect(() => {
    function onDocClick(e: MouseEvent) {
      if (!rootRef.current) return;
      if (!rootRef.current.contains(e.target as Node)) {
        setOpen(false);
        setShowNew(false);
      }
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        setOpen(false);
        setShowNew(false);
      }
    }
    if (open) {
      document.addEventListener('mousedown', onDocClick);
      document.addEventListener('keydown', onKey);
    }
    return () => {
      document.removeEventListener('mousedown', onDocClick);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  function handleCreate() {
    const normalized = normalizeAppName(newName);
    if (!normalized) return;
    setActiveAppName(normalized);
    setNewName('');
    setShowNew(false);
    setOpen(false);
  }

  return (
    <div ref={rootRef} className="relative inline-block">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="inline-flex items-center gap-2.5 rounded-xl border border-border bg-card px-3 py-1.5 text-[13px] hover:border-muted-foreground/50 transition-colors"
      >
        <span
          className="h-[7px] w-[7px] rounded-full shrink-0"
          style={{
            background: active ? statusDotColor(active) : '#6b7280',
            boxShadow:
              active?.bmad?.bmadStatus === 'HEALTHY'
                ? '0 0 0 2px rgba(74,222,128,0.18)'
                : undefined,
          }}
        />
        {active ? (
          <>
            <span className="font-semibold">{active.displayName}</span>
            <span className="text-muted-foreground font-mono text-[11px]">
              {shortenPath(active.path)}
            </span>
            {active.bmad && <BmadChip status={active.bmad.bmadStatus} />}
            {active.epic && <StageChip stage={epicStatusToStage(active.epic.status)} />}
            {active.bmad?.bmadVersion && (
              <span className="inline-flex items-center rounded-full border border-border bg-muted/40 px-2 py-0.5 text-[10.5px] font-mono text-muted-foreground">
                bmad {active.bmad.bmadVersion}
              </span>
            )}
            {active.bmad?.agentCount != null && (
              <span className="inline-flex items-center rounded-full border border-border bg-muted/40 px-2 py-0.5 text-[10.5px] font-mono text-muted-foreground">
                {active.bmad.agentCount}/{active.bmad.expectedAgentCount} agents
              </span>
            )}
            {active.bmad?.lastInspectedAt && (
              <span className="text-muted-foreground text-[11px]">
                · {formatDistanceToNow(new Date(active.bmad.lastInspectedAt))} ago
              </span>
            )}
          </>
        ) : (
          <span className="text-muted-foreground">Select project</span>
        )}
        <ChevronDown className="h-3 w-3 text-muted-foreground/70 ml-1 shrink-0" />
      </button>

      {open && (
        <div
          className="absolute top-[calc(100%+6px)] left-0 z-50 w-[560px] max-h-[460px] flex flex-col overflow-hidden rounded-xl border border-border bg-popover"
          style={{ boxShadow: '0 20px 60px rgba(0,0,0,0.6), 0 0 0 1px rgba(255,255,255,0.02)' }}
        >
          {/* Search header */}
          <div className="flex items-center gap-2 border-b border-border px-3 py-2.5">
            <Search className="h-3.5 w-3.5 text-muted-foreground opacity-70" />
            <input
              autoFocus
              placeholder="Search projects…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              className="flex-1 bg-transparent text-[13px] outline-none text-foreground"
            />
            <span className="party-kbd">Esc</span>
          </div>

          {/* Rows */}
          <div className="flex-1 overflow-y-auto p-1.5">
            {filtered.length === 0 && (
              <div className="px-5 py-8 text-center text-xs text-muted-foreground">
                No matches. Create a folder in{' '}
                <code className="font-mono bg-muted/60 px-1 py-0.5 rounded">~/projects/</code> and
                re-inspect.
              </div>
            )}
            {filtered.map((row) => {
              const stage = row.epic ? epicStatusToStage(row.epic.status) : null;
              const isActive = row.appName === activeAppName;
              return (
                <button
                  key={row.appName}
                  type="button"
                  onClick={() => {
                    setActiveAppName(row.appName);
                    setOpen(false);
                  }}
                  className={`flex w-full items-center gap-3 rounded-lg px-2.5 py-2 text-left transition-colors ${
                    isActive ? 'bg-white/[0.04]' : 'hover:bg-white/[0.03]'
                  }`}
                >
                  <span
                    className="h-[7px] w-[7px] rounded-full shrink-0"
                    style={{ background: statusDotColor(row) }}
                  />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="text-[13px] font-semibold">{row.displayName}</span>
                      {row.bmad && <BmadChip status={row.bmad.bmadStatus} small />}
                      {stage && <StageChip stage={stage} small />}
                      {isActive && <Check className="h-3 w-3 text-primary" />}
                    </div>
                    <div className="mt-0.5 truncate text-[11px] font-mono text-muted-foreground">
                      {row.path}
                    </div>
                  </div>
                  <div className="text-right text-[10.5px] font-mono text-muted-foreground flex flex-col gap-0.5 shrink-0">
                    {row.bmad?.bmadVersion && <span>bmad {row.bmad.bmadVersion}</span>}
                    {row.bmad?.agentCount != null && (
                      <span>
                        {row.bmad.agentCount}/{row.bmad.expectedAgentCount} agents
                      </span>
                    )}
                    {row.epic && row.epic.totalStories > 0 && (
                      <span>
                        {row.epic.doneStories}/{row.epic.totalStories} stories
                      </span>
                    )}
                    {row.bmad?.lastInspectedAt && (
                      <span>{formatDistanceToNow(new Date(row.bmad.lastInspectedAt))} ago</span>
                    )}
                  </div>
                </button>
              );
            })}
          </div>

          {/* Footer */}
          <div className="border-t border-border bg-muted/20">
            {!showNew ? (
              <div className="flex items-center justify-between px-3 py-2 text-[10.5px] text-muted-foreground">
                <button
                  type="button"
                  onClick={() => setShowNew(true)}
                  className="inline-flex items-center gap-1.5 text-muted-foreground hover:text-foreground"
                >
                  <Plus className="h-3 w-3" />
                  New project
                </button>
                <span>
                  {rows.length} projects ·{' '}
                  <span className="text-success">{healthyCount} healthy</span>
                </span>
              </div>
            ) : (
              <div className="flex items-center gap-2 px-3 py-2">
                <input
                  autoFocus
                  type="text"
                  value={newName}
                  onChange={(e) => setNewName(e.target.value)}
                  placeholder="project-name"
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') handleCreate();
                    if (e.key === 'Escape') {
                      setShowNew(false);
                      setNewName('');
                    }
                  }}
                  className="flex-1 rounded border border-input bg-background px-2 py-1.5 text-xs font-mono focus:outline-none focus:ring-1 focus:ring-ring"
                />
                <button
                  type="button"
                  onClick={handleCreate}
                  disabled={!normalizeAppName(newName)}
                  className="rounded bg-primary px-2 py-1.5 text-[11px] text-primary-foreground disabled:opacity-50"
                >
                  Create
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setShowNew(false);
                    setNewName('');
                  }}
                  className="text-[10.5px] text-muted-foreground hover:text-foreground"
                >
                  Cancel
                </button>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function BmadChip({ status, small = false }: { status: BmadStatus; small?: boolean }) {
  const def = BMAD_BADGE[status] ?? BMAD_BADGE.MISSING;
  return (
    <span
      className={`inline-flex items-center rounded-full border px-2 py-0 text-[${small ? '10' : '10.5'}px] font-medium ${def.className}`}
    >
      {def.label}
    </span>
  );
}

function StageChip({ stage, small = false }: { stage: string; small?: boolean }) {
  const def = VERSION_STAGES.find((s) => s.id === stage);
  if (!def) return null;
  const cls = STAGE_COLOR[stage] ?? STAGE_COLOR.concept;
  return (
    <span
      className={`inline-flex items-center rounded-full border px-2 py-0 text-[${small ? '10' : '10.5'}px] font-medium ${cls}`}
    >
      {def.label}
    </span>
  );
}

export function PipelineStageRail() {
  const { activeAppName } = useLabsStore();
  const { data: epics } = useEpicList();
  const epic = (epics || []).find((e) => normalizeAppName(e.appName) === activeAppName);
  if (!epic) return null;
  const current = epicStatusToStage(epic.status);
  const currentIndex = VERSION_STAGES.findIndex((s) => s.id === current);
  return (
    <div className="flex items-center gap-1">
      {VERSION_STAGES.map((stage, index) => {
        const isPast = index < currentIndex;
        const isCurrent = index === currentIndex;
        return (
          <div key={stage.id} className="flex items-center">
            <span
              className={`px-2 py-0.5 rounded text-[10px] font-medium transition-all ${
                isCurrent
                  ? 'bg-primary text-primary-foreground'
                  : isPast
                    ? 'bg-green-500/15 text-green-500'
                    : 'bg-secondary/50 text-muted-foreground'
              }`}
            >
              {stage.label}
            </span>
            {index < VERSION_STAGES.length - 1 && (
              <div className={`w-3 h-px mx-0.5 ${isPast ? 'bg-green-500' : 'bg-border'}`} />
            )}
          </div>
        );
      })}
    </div>
  );
}
