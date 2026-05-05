'use client';
import { useEffect, useRef, useState } from 'react';
import { Globe, Hash, Pencil, X } from 'lucide-react';
import { DEFAULT_ALLOWED_TOOLS } from '@/types/party';
import { COLORS } from './tokens';
import { AgentCard } from './agent-card';
import {
  OrchestratorOpen,
  OrchestratorClose,
  OrchestratorMidNote,
  UserQuestionBanner,
  AgentCardSkeleton,
} from './orchestrator-cards';
import type { Round } from '../turn-adapter';
import type { PartyBlock } from '../turn-parser';

interface UserIdentity {
  /** Display name shown above the user's bubble. */
  name: string;
  /** Initial(s) for the avatar circle. */
  initial: string;
  /** Optional avatar image URL (from OAuth). */
  picture?: string;
}

interface Props {
  /** The session's title (editable). When empty, falls back to "Untitled session". */
  title: string;
  /** Channel/project name shown as the breadcrumb prefix. */
  channel: string;
  rounds: Round[];
  /** Round to scroll to when selected from the right rail. */
  pinnedRoundId: string | null;
  /** True when we're waiting on Claude's first chunk in the active round. */
  showSkeleton: boolean;
  /** Identity of the signed-in user — used in the user-question banner. */
  user: UserIdentity;
  /** Currently allowed extra tools (WebSearch/WebFetch). undefined → defaults. */
  allowedTools?: string[];
  /** Toggle a single tool on/off. Optimistic update is in the parent hook. */
  onToggleTool?: (tool: string, next: boolean) => void;
  onClose?: () => void;
  /** Persist a new title. Receives null when cleared. */
  onRename?: (title: string | null) => void;
}

/**
 * Main pane — renders the WHOLE conversation as a continuous thread.
 *
 * Earlier versions swapped content per-round, which made round 2 feel like
 * "the chat reset" — bad mental model for a debate that's meant to be a
 * single ongoing conversation. Now all rounds stack vertically; the right
 * rail's "round" buttons just anchor-scroll to the start of that round's
 * banner. Skeletons append BELOW existing content (never replace it).
 */
export function MainPane({
  title,
  channel,
  rounds,
  pinnedRoundId,
  showSkeleton,
  user,
  allowedTools,
  onToggleTool,
  onClose,
  onRename,
}: Props) {
  const ref = useRef<HTMLDivElement | null>(null);

  // Auto-scroll on new content within the latest round, but NOT when the
  // user manually picks an older round from the rail (we anchor-scroll
  // instead in that case).
  const lastRoundBlockCount = rounds[rounds.length - 1]?.blocks.length ?? 0;
  useEffect(() => {
    if (!ref.current) return;
    if (pinnedRoundId) return; // explicit navigation owns scroll
    ref.current.scrollTop = ref.current.scrollHeight;
  }, [lastRoundBlockCount, rounds.length, pinnedRoundId]);

  // Anchor-scroll when the user clicks a round in the right rail.
  useEffect(() => {
    if (!pinnedRoundId || !ref.current) return;
    const el = ref.current.querySelector<HTMLElement>(`[data-round-anchor="${pinnedRoundId}"]`);
    if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }, [pinnedRoundId]);

  return (
    <div
      className="flex h-full flex-col"
      style={{ background: COLORS.bgContent }}
    >
      <Header
        title={title}
        channel={channel}
        roundCount={rounds.length}
        allowedTools={allowedTools}
        onToggleTool={onToggleTool}
        onClose={onClose}
        onRename={onRename}
      />

      <div ref={ref} className="flex-1 overflow-y-auto py-4">
        {rounds.length === 0 && !showSkeleton && (
          <div
            className="mx-auto mt-12 max-w-md px-6 text-center"
            style={{ color: COLORS.textMuted }}
          >
            <div className="text-[18px] font-semibold" style={{ color: COLORS.textPrimary }}>
              Start a debate
            </div>
            <div className="mt-2 text-[13px]">
              Send a message in the left pane. Agents will respond in the
              orchestrator&apos;s voice — each one gets its own card.
            </div>
          </div>
        )}

        {rounds.map((r, i) => (
          <RoundView
            key={r.id}
            round={r}
            isFirst={i === 0}
            user={user}
            showSkeleton={showSkeleton && r.isInflight && r.blocks.length === 0}
          />
        ))}

        {showSkeleton && rounds.length === 0 && (
          <>
            <AgentCardSkeleton />
            <AgentCardSkeleton />
            <AgentCardSkeleton />
          </>
        )}
      </div>
    </div>
  );
}

function Header({
  title,
  channel,
  roundCount,
  allowedTools,
  onToggleTool,
  onClose,
  onRename,
}: {
  title: string;
  channel: string;
  roundCount: number;
  allowedTools?: string[];
  onToggleTool?: (tool: string, next: boolean) => void;
  onClose?: () => void;
  onRename?: (title: string | null) => void;
}) {
  // `draft` is null when not editing; populated with a string snapshot of
  // `title` the moment edit starts. This avoids mirroring `title` into a
  // useEffect (which lints as set-state-in-effect) and makes the read-only
  // path purely a function of props.
  const [draft, setDraft] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const editing = draft !== null;

  function startEdit() {
    if (!onRename) return;
    setDraft(title);
    setTimeout(() => inputRef.current?.select(), 0);
  }

  function commit() {
    if (!onRename || draft === null) {
      setDraft(null);
      return;
    }
    const next = draft.trim();
    setDraft(null);
    if (next === title.trim()) return;
    onRename(next.length > 0 ? next : null);
  }

  function cancel() {
    setDraft(null);
  }

  return (
    <header
      className="flex shrink-0 items-center gap-2 px-5"
      style={{
        height: 56,
        borderBottom: `1px solid ${COLORS.bgDeepest}`,
        boxShadow: '0 1px 0 rgba(0,0,0,0.2)',
      }}
    >
      <Hash className="h-4 w-4 shrink-0" style={{ color: COLORS.textMuted }} />
      {editing ? (
        <input
          ref={inputRef}
          value={draft ?? ''}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              commit();
            } else if (e.key === 'Escape') {
              e.preventDefault();
              cancel();
            }
          }}
          placeholder="Untitled session"
          maxLength={200}
          className="min-w-0 flex-1 rounded-md border bg-transparent px-2 py-1 text-[15px] font-semibold focus:outline-none"
          style={{
            color: COLORS.textPrimary,
            borderColor: COLORS.bgDeepest,
          }}
        />
      ) : (
        <button
          type="button"
          onClick={startEdit}
          disabled={!onRename}
          title={onRename ? 'Click to rename session' : undefined}
          className="group flex min-w-0 items-center gap-2 rounded-md px-1 py-1 text-left transition-colors disabled:cursor-default"
          onMouseEnter={(e) => {
            if (!onRename) return;
            e.currentTarget.style.background = 'rgba(255,255,255,0.04)';
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.background = 'transparent';
          }}
        >
          <span
            className="truncate text-[15px] font-semibold"
            style={{
              color: title.trim() ? COLORS.textPrimary : COLORS.textMuted,
              fontStyle: title.trim() ? 'normal' : 'italic',
            }}
          >
            {title.trim() || 'Untitled session'}
          </span>
          {onRename && (
            <Pencil
              className="h-3 w-3 opacity-0 transition-opacity group-hover:opacity-60"
              style={{ color: COLORS.textMuted }}
            />
          )}
        </button>
      )}

      <span className="ml-2 shrink-0 text-[12px]" style={{ color: COLORS.textMuted }}>
        · {channel} · {roundCount} round{roundCount === 1 ? '' : 's'}
      </span>

      <span className="ml-auto" />

      {onToggleTool && <WebSearchToggle allowedTools={allowedTools} onToggle={onToggleTool} />}
      {onClose && (
        <button
          type="button"
          onClick={onClose}
          className="rounded-md p-1.5 transition-colors"
          style={{ color: COLORS.textMuted }}
          title="Close session"
          onMouseEnter={(e) => {
            e.currentTarget.style.background = 'rgba(255,255,255,0.05)';
            e.currentTarget.style.color = COLORS.textPrimary;
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.background = 'transparent';
            e.currentTarget.style.color = COLORS.textMuted;
          }}
        >
          <X className="h-4 w-4" />
        </button>
      )}
    </header>
  );
}

/**
 * Tiny chip in the header that flips WebSearch on/off for this project.
 * "Allowed" = the project's allowedTools (or DEFAULT_ALLOWED_TOOLS if
 * undefined) contains "WebSearch". Click toggles. Costs are non-trivial
 * (~$0.01/query against Anthropic's WebSearch tool), hence the visible
 * affordance instead of an invisible default.
 */
function WebSearchToggle({
  allowedTools,
  onToggle,
}: {
  allowedTools?: string[];
  onToggle: (tool: string, next: boolean) => void;
}) {
  const effective = allowedTools ?? Array.from(DEFAULT_ALLOWED_TOOLS);
  const enabled = effective.includes('WebSearch');
  return (
    <button
      type="button"
      onClick={() => onToggle('WebSearch', !enabled)}
      title={
        enabled
          ? 'Web search is ON for this project — agents can call WebSearch (~$0.01/query). Click to disable.'
          : 'Web search is OFF — agents will fall back to model knowledge. Click to enable.'
      }
      className="mr-1 inline-flex items-center gap-1.5 rounded-md border px-2 py-[3px] text-[11px] font-medium transition-colors"
      style={{
        background: enabled
          ? 'rgba(74,222,128,0.12)'
          : 'rgba(255,255,255,0.04)',
        borderColor: enabled
          ? 'rgba(74,222,128,0.35)'
          : 'rgba(255,255,255,0.08)',
        color: enabled ? COLORS.accentLive : COLORS.textMuted,
      }}
    >
      <Globe className="h-3 w-3" />
      web {enabled ? 'on' : 'off'}
    </button>
  );
}

/**
 * Single round inside the continuous thread. First round renders flush;
 * subsequent rounds get a slim "Round N · time" divider on top so the
 * eye can find the boundary without losing the conversation flow.
 */
function RoundView({
  round,
  isFirst,
  user,
  showSkeleton,
}: {
  round: Round;
  isFirst: boolean;
  user: UserIdentity;
  showSkeleton: boolean;
}) {
  const segments = segmentBlocks(round.blocks);
  const inflightAgentIdx = round.isInflight ? lastAgentIndex(round.blocks) : -1;

  return (
    <section data-round-anchor={round.id}>
      {!isFirst && <RoundDivider n={round.n} status={round.status} />}

      <UserQuestionBanner
        text={round.user.text}
        timestamp={new Date(round.startedAt).toLocaleTimeString([], {
          hour: 'numeric',
          minute: '2-digit',
        })}
        userName={user.name}
        userInitial={user.initial}
        userPicture={user.picture}
      />

      {(segments.openText || round.tools.length > 0) && (
        <OrchestratorOpen
          text={segments.openText ?? ''}
          agentCount={round.speakers.length}
          streaming={
            round.isInflight && round.blocks.length === 1 && round.blocks[0].kind !== 'agent'
          }
          tools={round.tools}
          // Auto-expand the tool log only while the round is still cold-
          // starting (no agent text yet). Once agents start talking we
          // collapse so it doesn't dominate the view.
          toolsDefaultOpen={round.isInflight && round.speakers.length === 0}
        />
      )}

      {segments.mainSequence.map((entry, i) => {
        if (entry.kind === 'agent') {
          const isStreaming = entry.indexInBlocks === inflightAgentIdx;
          return (
            <AgentCard
              key={`${entry.indexInBlocks}-${entry.block.speaker}`}
              speaker={entry.block.speaker || 'Unknown'}
              text={entry.block.text}
              streaming={isStreaming}
            />
          );
        }
        return (
          <OrchestratorMidNote
            key={`mid-${entry.indexInBlocks}-${i}`}
            text={entry.block.text}
            eyebrow={midNoteEyebrow(round.blocks, entry.indexInBlocks)}
          />
        );
      })}

      {segments.closeText && <OrchestratorClose text={segments.closeText} n={round.n} />}

      {showSkeleton && (
        <>
          <AgentCardSkeleton />
          <AgentCardSkeleton />
        </>
      )}

      {round.status === 'error' && (
        <div
          className="mx-6 mb-3 rounded-md px-3 py-2 text-[12px]"
          style={{
            background: 'rgba(248,113,113,0.08)',
            border: '1px solid rgba(248,113,113,0.3)',
            color: '#fca5a5',
          }}
        >
          Round {round.n} ended in error
          {round.errorReason ? ` (${round.errorReason})` : ''}. Send a new
          message below to continue.
        </div>
      )}
    </section>
  );
}

function RoundDivider({ n, status }: { n: number; status: Round['status'] }) {
  const live = status === 'active';
  return (
    <div className="mx-6 my-4 flex items-center gap-3">
      <div className="h-px flex-1" style={{ background: COLORS.bgDeepest }} />
      <span
        className="rounded-[10px] px-2.5 py-[3px] font-mono text-[10.5px] font-semibold uppercase tracking-wider"
        style={{
          background: live ? 'rgba(74,222,128,0.18)' : 'rgba(255,255,255,0.04)',
          color: live ? COLORS.accentLive : COLORS.textMuted,
          border: live
            ? '1px solid rgba(74,222,128,0.35)'
            : '1px solid rgba(255,255,255,0.06)',
        }}
      >
        {live && '● '}Round {n}
      </span>
      <div className="h-px flex-1" style={{ background: COLORS.bgDeepest }} />
    </div>
  );
}

interface Segments {
  openText: string | null;
  closeText: string | null;
  mainSequence: Array<
    | { kind: 'agent'; block: PartyBlock; indexInBlocks: number }
    | { kind: 'mid'; block: PartyBlock; indexInBlocks: number }
  >;
}

function segmentBlocks(blocks: PartyBlock[]): Segments {
  if (blocks.length === 0) return { openText: null, closeText: null, mainSequence: [] };

  let firstAgent = -1;
  let lastAgent = -1;
  blocks.forEach((b, i) => {
    if (b.kind === 'agent') {
      if (firstAgent === -1) firstAgent = i;
      lastAgent = i;
    }
  });

  if (firstAgent === -1) {
    return {
      openText: blocks.map((b) => b.text).join('\n\n').trim() || null,
      closeText: null,
      mainSequence: [],
    };
  }

  const openText =
    blocks
      .slice(0, firstAgent)
      .map((b) => b.text)
      .join('\n\n')
      .trim() || null;

  const closeText =
    blocks
      .slice(lastAgent + 1)
      .filter((b) => b.kind !== 'agent')
      .map((b) => b.text)
      .join('\n\n')
      .trim() || null;

  const mainSequence: Segments['mainSequence'] = [];
  for (let i = firstAgent; i <= lastAgent; i++) {
    const b = blocks[i];
    if (b.kind === 'agent') {
      mainSequence.push({ kind: 'agent', block: b, indexInBlocks: i });
    } else {
      mainSequence.push({ kind: 'mid', block: b, indexInBlocks: i });
    }
  }
  return { openText, closeText, mainSequence };
}

function lastAgentIndex(blocks: PartyBlock[]): number {
  for (let i = blocks.length - 1; i >= 0; i--) {
    if (blocks[i].kind === 'agent') return i;
  }
  return -1;
}

function midNoteEyebrow(blocks: PartyBlock[], midIdx: number): string | undefined {
  let prev: string | undefined;
  let next: string | undefined;
  for (let i = midIdx - 1; i >= 0; i--) {
    if (blocks[i].kind === 'agent') {
      prev = blocks[i].speaker || undefined;
      break;
    }
  }
  for (let i = midIdx + 1; i < blocks.length; i++) {
    if (blocks[i].kind === 'agent') {
      next = blocks[i].speaker || undefined;
      break;
    }
  }
  if (prev && next) return `${prev} → ${next}`;
  if (prev) return prev;
  if (next) return `next: ${next}`;
  return undefined;
}
