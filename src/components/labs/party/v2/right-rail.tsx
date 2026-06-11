'use client';
import { useId, useMemo, useState } from 'react';
import {
  Clock,
  FileText,
  HelpCircle,
  Loader2,
  Plus,
  ScrollText,
  Trash2,
  Upload,
} from 'lucide-react';
import { usePartyDocs, useDeletePartyDoc, useUploadPartyDoc } from '@/hooks/use-party-docs';
import type { PartyDoc } from '@/hooks/use-party-docs';
import type { PartyEvent } from '@/types/party';
import { COLORS, HEADER_H, RAIL_STRIP_W, RAIL_TAB_KEY } from './tokens';
import type { Round } from '../turn-adapter';
import { RoundRail } from './round-rail';
import { AgentQuestionsCard } from './agent-questions-card';
import { InlineQuestionsList } from './inline-questions-list';
import { useFileDrawer } from './file-drawer';

export type RailTab = 'rounds' | 'uploads' | 'generated' | 'questions';

const TABS: Array<{ id: RailTab; icon: typeof Clock; label: string }> = [
  { id: 'rounds', icon: Clock, label: 'Rounds' },
  { id: 'uploads', icon: Upload, label: 'Uploaded documents' },
  { id: 'generated', icon: FileText, label: 'Generated documents' },
  { id: 'questions', icon: HelpCircle, label: 'Asked questions' },
];

function loadTab(): RailTab | null {
  if (typeof window === 'undefined') return 'rounds';
  try {
    const raw = window.localStorage.getItem(RAIL_TAB_KEY);
    if (raw === 'null') return null; // user collapsed the panel last time
    if (raw && TABS.some((t) => t.id === raw)) return raw as RailTab;
  } catch {
    /* fall through */
  }
  return 'rounds';
}

interface Props {
  rounds: Round[];
  activeRoundId: string | null;
  onSelectRound: (roundId: string) => void;
  events: ReadonlyArray<PartyEvent>;
  onJumpToRound: (roundN: number) => void;
  onJumpToAnchor: (roundId: string) => void;
  sessionId: string;
  projectId: string | null;
  /** Insert a `./.party-uploads/<file>` reference into the composer. */
  onPickDoc?: (filename: string) => void;
  /** Session upload (composer pipeline — shows progress pills there too). */
  onAttach?: (files: File[]) => void;
  onOpenAudit: () => void;
  /** Resizable panel width (from usePaneResize). */
  panelWidth: number;
}

/**
 * Right rail — a far-right icon strip + one switchable panel, replacing the
 * stacked Rounds/Questions column. Clicking the active icon collapses the
 * panel entirely (full-width debate); the choice persists per browser.
 */
export function RightRail({
  rounds,
  activeRoundId,
  onSelectRound,
  events,
  onJumpToRound,
  onJumpToAnchor,
  sessionId,
  projectId,
  onPickDoc,
  onAttach,
  onOpenAudit,
  panelWidth,
}: Props) {
  const [tab, setTab] = useState<RailTab | null>(() => loadTab());

  function pick(next: RailTab) {
    const value = next === tab ? null : next; // toggle-collapse
    setTab(value);
    try {
      window.localStorage.setItem(RAIL_TAB_KEY, String(value));
    } catch {
      /* best effort */
    }
  }

  // Unanswered ASK_HUMAN heuristic for the badge dot: a question event with
  // no user turn after it (same rule AgentQuestionsCard uses internally).
  const hasOpenQuestion = useMemo(() => {
    let lastQuestionSeq: string | null = null;
    let lastUserSeq: string | null = null;
    for (const e of events) {
      const seq = String(e.eventSeq ?? '000000');
      if (e.eventType === 'party.agent.question') lastQuestionSeq = seq;
      if (e.eventType === 'party.turn.user') lastUserSeq = seq;
    }
    if (!lastQuestionSeq) return false;
    return lastUserSeq === null || lastUserSeq < lastQuestionSeq;
  }, [events]);

  return (
    <div className="flex h-full" style={{ background: COLORS.bgSurface }}>
      {tab !== null && (
        <div className="flex h-full min-w-0 shrink-0 flex-col" style={{ width: panelWidth }}>
          {tab === 'rounds' && (
            <RoundRail rounds={rounds} activeRoundId={activeRoundId} onSelect={onSelectRound} />
          )}
          {tab === 'uploads' && (
            <UploadedDocsPanel
              projectId={projectId}
              sessionId={sessionId}
              onPickDoc={onPickDoc}
              onAttach={onAttach}
            />
          )}
          {tab === 'generated' && <GeneratedDocsPanel rounds={rounds} />}
          {tab === 'questions' && (
            <div className="flex-1 overflow-y-auto">
              <AgentQuestionsCard events={events} onJumpToRound={onJumpToRound} />
              <InlineQuestionsList sessionId={sessionId} onJumpTo={onJumpToAnchor} />
            </div>
          )}
        </div>
      )}

      <nav
        className="flex h-full shrink-0 flex-col items-center gap-1 py-2"
        style={{
          width: RAIL_STRIP_W,
          borderLeft: `1px solid ${COLORS.bgDeepest}`,
        }}
        aria-label="Debate side panels"
      >
        {TABS.map(({ id, icon: Icon, label }) => {
          const active = tab === id;
          return (
            <button
              key={id}
              type="button"
              onClick={() => pick(id)}
              title={`${label}${active ? ' — click to collapse' : ''}`}
              aria-pressed={active}
              className="relative flex h-9 w-9 items-center justify-center rounded-lg transition-colors"
              style={{
                background: active
                  ? 'color-mix(in srgb, var(--party-accent-brand) 22%, transparent)'
                  : 'transparent',
                color: active ? COLORS.accentBrand : COLORS.textMuted,
              }}
              onMouseEnter={(e) => {
                if (!active)
                  e.currentTarget.style.background =
                    'color-mix(in srgb, var(--foreground) 6%, transparent)';
              }}
              onMouseLeave={(e) => {
                if (!active) e.currentTarget.style.background = 'transparent';
              }}
            >
              <Icon className="h-4 w-4" />
              {id === 'questions' && hasOpenQuestion && (
                <span
                  className="absolute right-1 top-1 h-1.5 w-1.5 rounded-full"
                  style={{ background: 'var(--warning, #f59e0b)' }}
                  aria-label="Unanswered question"
                />
              )}
            </button>
          );
        })}

        <span className="flex-1" />

        <button
          type="button"
          onClick={onOpenAudit}
          title="Audit log — checkpoints, questions, tool default-allows"
          className="flex h-9 w-9 items-center justify-center rounded-lg transition-colors"
          style={{ color: COLORS.textMuted }}
          data-testid="open-audit-drawer"
          onMouseEnter={(e) => {
            e.currentTarget.style.background =
              'color-mix(in srgb, var(--foreground) 6%, transparent)';
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.background = 'transparent';
          }}
        >
          <ScrollText className="h-4 w-4" />
        </button>
      </nav>
    </div>
  );
}

/* ── Uploaded documents panel ─────────────────────────────────────── */

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

function UploadedDocsPanel({
  projectId,
  sessionId,
  onPickDoc,
  onAttach,
}: {
  projectId: string | null;
  sessionId: string;
  onPickDoc?: (filename: string) => void;
  onAttach?: (files: File[]) => void;
}) {
  const { data, isLoading } = usePartyDocs(projectId, sessionId);
  const del = useDeletePartyDoc(projectId, sessionId);
  const upload = useUploadPartyDoc(projectId, sessionId);
  const sessionInputId = useId();
  const sharedInputId = useId();
  const [dragOver, setDragOver] = useState(false);

  const sessionDocs: PartyDoc[] = data?.session ?? [];
  const sharedDocs: PartyDoc[] = data?.shared ?? [];
  const total = sessionDocs.length + sharedDocs.length;

  function onSessionPicked(e: React.ChangeEvent<HTMLInputElement>) {
    const files = Array.from(e.target.files ?? []);
    e.target.value = '';
    if (files.length && onAttach) onAttach(files);
  }

  async function onSharedPicked(e: React.ChangeEvent<HTMLInputElement>) {
    const files = Array.from(e.target.files ?? []);
    e.target.value = '';
    for (const file of files) {
      try {
        await upload.mutateAsync({ file, scope: 'shared' });
      } catch (err) {
        console.error('[Party] shared doc upload failed:', file.name, err);
      }
    }
  }

  function onDrop(e: React.DragEvent) {
    e.preventDefault();
    setDragOver(false);
    const files = Array.from(e.dataTransfer.files ?? []);
    if (files.length && onAttach) onAttach(files);
  }

  return (
    <div className="flex h-full flex-col">
      <PanelHeader title="Uploaded documents" meta={`${total} file${total === 1 ? '' : 's'}`} />

      <div className="flex-1 space-y-2 overflow-y-auto px-3 py-3">
        {/* Session-scope drop zone (mirrors the composer paperclip pipeline
            so progress pills appear in the Curator pane too). */}
        <label
          htmlFor={sessionInputId}
          onDragOver={(e) => {
            e.preventDefault();
            setDragOver(true);
          }}
          onDragLeave={() => setDragOver(false)}
          onDrop={onDrop}
          className="flex cursor-pointer flex-col items-center gap-1 rounded-lg border border-dashed px-3 py-4 text-center transition-colors"
          style={{
            borderColor: dragOver
              ? COLORS.accentBrand
              : 'color-mix(in srgb, var(--foreground) 18%, transparent)',
            background: dragOver
              ? 'color-mix(in srgb, var(--party-accent-brand) 8%, transparent)'
              : 'transparent',
            color: COLORS.textMuted,
          }}
        >
          <Upload className="h-4 w-4" />
          <span className="text-[11.5px]">Drop a file or click to upload</span>
          <span className="text-[10px]" style={{ color: COLORS.textFaint }}>
            visible to this debate only
          </span>
        </label>
        <input
          id={sessionInputId}
          type="file"
          multiple
          className="sr-only"
          onChange={onSessionPicked}
          disabled={!onAttach}
        />

        {isLoading && total === 0 && (
          <div
            className="flex items-center gap-2 px-1 py-2 text-[11.5px]"
            style={{ color: COLORS.textMuted }}
          >
            <Loader2 className="h-3 w-3 animate-spin" /> Loading docs…
          </div>
        )}

        {sessionDocs.map((doc) => (
          <DocRow
            key={`session:${doc.filename}`}
            doc={doc}
            onPick={onPickDoc}
            onDelete={() => del.mutate({ filename: doc.filename, scope: 'session' })}
            deleting={del.isPending && del.variables?.filename === doc.filename}
          />
        ))}
        {sharedDocs.map((doc) => (
          <DocRow
            key={`shared:${doc.filename}`}
            doc={doc}
            shared
            onPick={onPickDoc}
            onDelete={() => del.mutate({ filename: doc.filename, scope: 'shared' })}
            deleting={del.isPending && del.variables?.filename === doc.filename}
          />
        ))}

        <label
          htmlFor={sharedInputId}
          className="inline-flex cursor-pointer items-center gap-1 rounded-full border border-dashed px-2 py-0.5 text-[11px] transition-colors"
          style={{
            borderColor: 'color-mix(in srgb, var(--foreground) 18%, transparent)',
            color: COLORS.textMuted,
          }}
          title="Add a shared doc — visible in every debate of this project"
        >
          {upload.isPending && upload.variables?.scope === 'shared' ? (
            <Loader2 className="h-3 w-3 animate-spin" />
          ) : (
            <Plus className="h-3 w-3" />
          )}
          shared doc
        </label>
        <input
          id={sharedInputId}
          type="file"
          className="sr-only"
          onChange={onSharedPicked}
          disabled={upload.isPending}
        />
      </div>
    </div>
  );
}

function DocRow({
  doc,
  shared = false,
  onPick,
  onDelete,
  deleting,
}: {
  doc: PartyDoc;
  shared?: boolean;
  onPick?: (filename: string) => void;
  onDelete: () => void;
  deleting: boolean;
}) {
  return (
    <div
      className="group flex items-center gap-2.5 rounded-lg border px-2.5 py-2"
      style={{
        background: COLORS.bgElevated,
        borderColor: COLORS.bgDeepest,
      }}
    >
      <span
        className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md"
        style={{
          background: 'color-mix(in srgb, var(--accent-blue) 18%, transparent)',
          color: 'var(--accent-blue)',
        }}
        aria-hidden
      >
        <FileText className="h-4 w-4" />
      </span>
      <button
        type="button"
        onClick={onPick ? () => onPick(doc.filename) : undefined}
        disabled={!onPick}
        className="min-w-0 flex-1 text-left"
        title={
          onPick
            ? `Click to insert ./.party-uploads/${doc.filename} into your message`
            : doc.filename
        }
      >
        <div className="truncate text-[12.5px] font-medium" style={{ color: COLORS.textPrimary }}>
          {doc.filename}
        </div>
        <div
          className="mt-0.5 flex items-center gap-1.5 text-[10.5px]"
          style={{ color: COLORS.textMuted }}
        >
          <span>{formatBytes(doc.size)}</span>
          {shared && (
            <span
              className="rounded-full border px-1.5 py-px text-[9.5px] font-semibold uppercase tracking-wide"
              style={{
                borderColor: 'color-mix(in srgb, var(--accent-blue) 40%, transparent)',
                color: 'var(--accent-blue)',
              }}
            >
              shared
            </span>
          )}
        </div>
      </button>
      <button
        type="button"
        onClick={onDelete}
        disabled={deleting}
        title={shared ? 'Remove shared doc' : 'Remove doc'}
        className="shrink-0 rounded-md p-1.5 opacity-0 transition-opacity group-hover:opacity-100 disabled:opacity-60"
        style={{ color: COLORS.textMuted }}
        onMouseEnter={(e) => {
          e.currentTarget.style.color = 'var(--destructive)';
        }}
        onMouseLeave={(e) => {
          e.currentTarget.style.color = COLORS.textMuted;
        }}
      >
        {deleting ? (
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
        ) : (
          <Trash2 className="h-3.5 w-3.5" />
        )}
      </button>
    </div>
  );
}

/* ── Generated documents panel ────────────────────────────────────── */

interface GeneratedDoc {
  /** Project-relative path — what the file drawer fetches. */
  path: string;
  filename: string;
  roundN: number;
  /** True when the last write came from the in-flight round. */
  live: boolean;
  writes: number;
  timestamp: string;
}

/**
 * Derive "documents the debate produced" from Write/Edit tool calls in the
 * round stream. No backend listing exists — the tool events are the source
 * of truth, which also gives us round attribution + live status for free.
 */
function deriveGeneratedDocs(rounds: Round[]): GeneratedDoc[] {
  const byPath = new Map<string, GeneratedDoc>();
  for (const round of rounds) {
    for (const tool of round.tools) {
      if (tool.name !== 'Write' && tool.name !== 'Edit') continue;
      const raw = typeof tool.input.file_path === 'string' ? tool.input.file_path : '';
      const path = normalizeGeneratedPath(raw);
      if (!path) continue;
      const prev = byPath.get(path);
      byPath.set(path, {
        path,
        filename: path.split('/').pop() ?? path,
        roundN: round.n,
        live: round.isInflight,
        writes: (prev?.writes ?? 0) + 1,
        timestamp: tool.timestamp,
      });
    }
  }
  // Most recently touched first.
  return Array.from(byPath.values()).sort((a, b) => b.timestamp.localeCompare(a.timestamp));
}

/**
 * Normalize a tool file_path to project-relative. Absolute worktree paths
 * (`/home/ubuntu/worktrees/<id>/_party/<sid>/docs/x.md`) and legacy project
 * paths get their prefix stripped; reference inputs (.party-uploads) and
 * anything still absolute after stripping are excluded.
 */
function normalizeGeneratedPath(p: string): string | null {
  if (!p) return null;
  let out = p.replace(/^\/home\/ubuntu\/(?:worktrees\/[^/]+\/_party\/[^/]+|projects\/[^/]+)\//, '');
  out = out.replace(/^\.\//, '');
  if (out.startsWith('/') || out.length === 0) return null;
  if (out.startsWith('.party-uploads/')) return null;
  return out;
}

function GeneratedDocsPanel({ rounds }: { rounds: Round[] }) {
  const drawer = useFileDrawer();
  const docs = useMemo(() => deriveGeneratedDocs(rounds), [rounds]);

  return (
    <div className="flex h-full flex-col">
      <PanelHeader
        title="Generated documents"
        meta={`${docs.length} doc${docs.length === 1 ? '' : 's'}`}
      />
      <div className="flex-1 space-y-2 overflow-y-auto px-3 py-3">
        {docs.length === 0 && (
          <div
            className="rounded-md border border-dashed px-3 py-4 text-center text-[11.5px]"
            style={{ borderColor: COLORS.bgDeepest, color: COLORS.textMuted }}
          >
            Nothing generated yet — when agents write specs or docs during the debate, they show up
            here.
          </div>
        )}
        {docs.map((doc) => (
          <button
            key={doc.path}
            type="button"
            onClick={drawer.enabled ? () => drawer.openPath(doc.path) : undefined}
            disabled={!drawer.enabled}
            className="flex w-full items-center gap-2.5 rounded-lg border px-2.5 py-2 text-left transition-colors"
            style={{ background: COLORS.bgElevated, borderColor: COLORS.bgDeepest }}
            title={doc.path}
            onMouseEnter={(e) => {
              e.currentTarget.style.borderColor =
                'color-mix(in srgb, var(--party-accent-brand) 45%, transparent)';
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.borderColor = 'var(--party-bg-deepest)';
            }}
          >
            <span
              className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md"
              style={{
                background: 'color-mix(in srgb, var(--accent-purple) 18%, transparent)',
                color: COLORS.accentOrch,
              }}
              aria-hidden
            >
              <FileText className="h-4 w-4" />
            </span>
            <span className="min-w-0 flex-1">
              <span
                className="block truncate text-[12.5px] font-medium"
                style={{ color: COLORS.textPrimary }}
              >
                {doc.filename}
              </span>
              <span
                className="mt-0.5 flex items-center gap-1.5 text-[10.5px]"
                style={{ color: COLORS.textMuted }}
              >
                {doc.live && (
                  <span
                    className="inline-flex items-center gap-1 font-semibold"
                    style={{ color: COLORS.accentLive }}
                  >
                    <span
                      className="h-1.5 w-1.5 animate-pulse rounded-full"
                      style={{ background: COLORS.accentLive }}
                    />
                    live
                  </span>
                )}
                <span>
                  {doc.live ? 'updating · ' : ''}Round {doc.roundN}
                </span>
                {doc.writes > 1 && <span>· {doc.writes} edits</span>}
              </span>
            </span>
          </button>
        ))}
      </div>
    </div>
  );
}

/* ── Shared panel chrome ──────────────────────────────────────────── */

function PanelHeader({ title, meta }: { title: string; meta?: string }) {
  return (
    <div
      className="flex shrink-0 items-center justify-between px-4"
      style={{ height: HEADER_H, borderBottom: `1px solid ${COLORS.bgDeepest}` }}
    >
      <span className="text-[13.5px] font-semibold" style={{ color: COLORS.textPrimary }}>
        {title}
      </span>
      {meta && (
        <span className="text-[11px]" style={{ color: COLORS.textMuted }}>
          {meta}
        </span>
      )}
    </div>
  );
}
