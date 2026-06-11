'use client';
import { useId, useRef, useEffect, type KeyboardEvent } from 'react';
import { ArrowRight, Paperclip, AtSign, Loader2, Sparkles } from 'lucide-react';
import { COLORS, HEADER_H } from './tokens';
import type { Round } from '../turn-adapter';
import { timeAgo } from '../turn-adapter';

export interface UploadStatusItem {
  filename: string;
  state: 'uploading' | 'done' | 'error';
  reason?: string;
}

interface Props {
  rounds: Round[];
  activeRoundId: string | null;
  draft: string;
  onDraftChange: (v: string) => void;
  onSend: () => void;
  isProcessing: boolean;
  isErrored?: boolean;
  /** Optional file attach handler (party-docs upload). */
  onAttach?: (files: File[]) => void;
  isUploading?: boolean;
  acceptedTypes?: string;
  /** Per-file upload progress pills, rendered above the composer. */
  uploadStatus?: UploadStatusItem[];
}

/**
 * Left pane — the "Curator" panel: a round-grouped feed of your messages and
 * the orchestrator's system notes, with the composer pinned to the bottom.
 *
 * 2026-06 redesign (claude.ai/design reference): the Chat/Sessions tabs are
 * gone — session navigation lives at /debates. The header is a slim Curator
 * identity row, round boundaries render as small-caps status markers
 * (`● ROUND 8 · CLOSED · 5 CONTRIBUTIONS`), and the composer textarea is
 * vertically resizable with a round-context eyebrow.
 */
export function LeftPane({
  rounds,
  activeRoundId,
  draft,
  onDraftChange,
  onSend,
  isProcessing,
  isErrored = false,
  onAttach,
  isUploading = false,
  acceptedTypes,
  uploadStatus = [],
}: Props) {
  return (
    <div className="flex h-full flex-col" style={{ background: COLORS.bgSurface }}>
      <CuratorHeader />

      <div className="flex-1 overflow-y-auto">
        <ChatHistory rounds={rounds} activeRoundId={activeRoundId} />
      </div>

      <ComposerBar
        currentRound={rounds[rounds.length - 1] ?? null}
        draft={draft}
        onChange={onDraftChange}
        onSend={onSend}
        isProcessing={isProcessing}
        isErrored={isErrored}
        onAttach={onAttach}
        isUploading={isUploading}
        acceptedTypes={acceptedTypes}
        uploadStatus={uploadStatus}
      />
    </div>
  );
}

function CuratorHeader() {
  return (
    <div
      className="flex shrink-0 items-center gap-2.5 px-4"
      style={{ height: HEADER_H, borderBottom: `1px solid ${COLORS.bgDeepest}` }}
    >
      <span
        className="flex h-6 w-6 items-center justify-center rounded-md"
        style={{
          background: 'color-mix(in srgb, var(--accent-purple) 18%, transparent)',
          color: COLORS.accentOrch,
        }}
        aria-hidden
      >
        <Sparkles className="h-3.5 w-3.5" />
      </span>
      <span className="text-[14px] font-semibold" style={{ color: COLORS.textPrimary }}>
        Curator
      </span>
      <span className="ml-auto text-[11px]" style={{ color: COLORS.textFaint }}>
        guiding the debate
      </span>
    </div>
  );
}

/** Chat body — round-status-marked history of user messages + system notes. */
function ChatHistory({ rounds, activeRoundId }: { rounds: Round[]; activeRoundId: string | null }) {
  const ref = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (ref.current) {
      const scroller = ref.current.parentElement;
      if (scroller) scroller.scrollTop = scroller.scrollHeight;
    }
  }, [rounds.length, activeRoundId]);

  if (rounds.length === 0) {
    return (
      <div
        className="m-4 rounded-md border border-dashed px-3 py-6 text-center text-[12px] italic"
        style={{ borderColor: COLORS.bgDeepest, color: COLORS.textMuted }}
      >
        Start a debate by sending a message below. Each round groups your question + the
        agents&apos; responses.
      </div>
    );
  }
  return (
    <div ref={ref} className="px-3 py-3">
      {rounds.map((r) => (
        <div key={r.id} className="mb-4">
          <RoundMarker round={r} />
          {r.speakers.length > 0 && (
            <SystemNote text={`Round ${r.n} started → ${r.speakers.join(', ')}`} accent />
          )}
          <UserBubble text={r.user.text} timestamp={timeAgo(r.startedAt)} />
          {r.status === 'done' && r.turns > 0 && (
            <SystemNote
              text={`Round ${r.n} closed · ${r.turns} contribution${r.turns === 1 ? '' : 's'} captured.`}
            />
          )}
          {r.status === 'awaiting' && (
            <SystemNote text="An agent asked you a follow-up — reply below." accent />
          )}
          {r.status === 'error' && (
            <SystemNote
              text={`Round ${r.n} failed${r.errorReason ? ` (${r.errorReason})` : ''}.`}
            />
          )}
        </div>
      ))}
    </div>
  );
}

/**
 * Reference-style round status marker: `● ROUND 8 · CLOSED · 5 CONTRIBUTIONS`.
 * Left-aligned small-caps row (not a centered divider) so the eye can scan
 * the timeline down the left edge.
 */
function RoundMarker({ round }: { round: Round }) {
  const live = round.isInflight;
  const statusLabel =
    round.status === 'done'
      ? 'CLOSED'
      : round.status === 'error'
        ? 'ERROR'
        : round.status === 'awaiting'
          ? 'AWAITING YOU'
          : 'STARTED';
  return (
    <div
      className="mb-1.5 mt-2 flex items-center gap-1.5 px-1 font-mono text-[10px] font-semibold uppercase tracking-wider"
      style={{ color: live ? COLORS.accentLive : COLORS.textFaint }}
    >
      <span
        className="h-1.5 w-1.5 shrink-0 rounded-full"
        style={{
          background: live
            ? COLORS.accentLive
            : round.status === 'error'
              ? 'var(--destructive)'
              : COLORS.textFaint,
        }}
      />
      <span>Round {round.n}</span>
      <span style={{ color: COLORS.textFaint }}>·</span>
      <span style={{ color: round.status === 'error' ? 'var(--destructive)' : undefined }}>
        {statusLabel}
      </span>
      {round.status === 'done' && round.turns > 0 && (
        <>
          <span style={{ color: COLORS.textFaint }}>·</span>
          <span>
            {round.turns} contribution{round.turns === 1 ? '' : 's'}
          </span>
        </>
      )}
    </div>
  );
}

/**
 * Curator/system note — plain elevated card (reference design), no emoji.
 * `accent` adds a soft purple left border for "something is happening" notes.
 */
function SystemNote({ text, accent = false }: { text: string; accent?: boolean }) {
  return (
    <div
      className="my-1 rounded-lg border px-3 py-2 text-[12.5px] leading-snug"
      style={{
        background: COLORS.bgElevated,
        borderColor: accent
          ? 'color-mix(in srgb, var(--accent-purple) 35%, transparent)'
          : COLORS.bgDeepest,
        borderLeftWidth: accent ? 2 : 1,
        color: COLORS.textBody,
      }}
    >
      {text}
    </div>
  );
}

function UserBubble({ text, timestamp }: { text: string; timestamp: string }) {
  return (
    <div className="my-1.5 flex flex-col items-end">
      <div
        className="max-w-[88%] whitespace-pre-wrap rounded-[14px] rounded-br-[4px] px-3 py-2 text-[13px] leading-snug text-white"
        style={{ background: COLORS.accentBrand }}
      >
        {text}
      </div>
      <span className="mt-0.5 text-[10px]" style={{ color: COLORS.textFaint }}>
        {timestamp}
      </span>
    </div>
  );
}

function ComposerBar({
  currentRound,
  draft,
  onChange,
  onSend,
  isProcessing,
  isErrored,
  onAttach,
  isUploading,
  acceptedTypes,
  uploadStatus,
}: {
  currentRound: Round | null;
  draft: string;
  onChange: (v: string) => void;
  onSend: () => void;
  isProcessing: boolean;
  isErrored: boolean;
  onAttach?: (files: File[]) => void;
  isUploading?: boolean;
  acceptedTypes?: string;
  uploadStatus: UploadStatusItem[];
}) {
  const taRef = useRef<HTMLTextAreaElement | null>(null);
  const fileInputId = useId();

  function handleKey(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      if (draft.trim()) onSend();
    }
  }

  function onPicked(e: React.ChangeEvent<HTMLInputElement>) {
    const files = Array.from(e.target.files ?? []);
    e.target.value = '';
    if (!onAttach) return;
    if (files.length) onAttach(files);
  }

  const placeholder = isProcessing
    ? 'Ask a follow-up while the debate runs…'
    : isErrored
      ? 'Session errored. Type a new message to start a fresh round…'
      : 'Type a message — agents will respond';

  const roundTitle = (currentRound?.user.text ?? '').slice(0, 48);

  return (
    <div className="shrink-0 px-3 pb-3 pt-1.5">
      {/* Round-context eyebrow — which round the next message lands in. */}
      <div className="flex items-center gap-1.5 px-1 pb-1.5 font-mono text-[10px] font-semibold uppercase tracking-wider">
        <span style={{ color: COLORS.textFaint }}>
          Round {(currentRound?.n ?? 0) + (currentRound?.isInflight ? 0 : 1)}
        </span>
        {roundTitle && (
          <>
            <span style={{ color: COLORS.textFaint }}>·</span>
            <span className="truncate" style={{ color: COLORS.accentBrand }}>
              {roundTitle}
            </span>
          </>
        )}
      </div>

      {isErrored && (
        <div
          className="mb-2 rounded-md px-2.5 py-1.5 text-[11px]"
          style={{
            background: 'color-mix(in srgb, var(--destructive) 12%, transparent)',
            color: 'var(--destructive)',
            border: '1px solid color-mix(in srgb, var(--destructive) 35%, transparent)',
          }}
        >
          Last round ended in ERROR. Send a new message to continue — the previous round&apos;s
          partial output is preserved above.
        </div>
      )}

      {uploadStatus.length > 0 && (
        <div className="mb-2 space-y-1">
          <div className="flex flex-wrap gap-1.5">
            {uploadStatus.map((s) => {
              const tone =
                s.state === 'uploading'
                  ? 'border-blue-400/30 bg-blue-500/15 text-blue-400'
                  : s.state === 'done'
                    ? 'border-emerald-400/30 bg-emerald-500/15 text-emerald-500'
                    : 'border-red-400/30 bg-red-500/15 text-red-400';
              return (
                <span
                  key={s.filename}
                  className={`inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 font-mono text-[10.5px] ${tone}`}
                  title={s.reason}
                >
                  {s.state === 'uploading' && <Loader2 className="h-2.5 w-2.5 animate-spin" />}
                  {s.state === 'done' && '✓'}
                  {s.state === 'error' && '✕'}
                  <span className="max-w-[200px] truncate">{s.filename}</span>
                </span>
              );
            })}
          </div>
          {uploadStatus.some((s) => s.state === 'done') && (
            <div className="px-1 text-[10.5px]" style={{ color: COLORS.textMuted }}>
              Uploaded — agents read these on your next Send.
            </div>
          )}
        </div>
      )}

      <div
        className="rounded-[10px] p-2.5"
        style={{
          background: COLORS.bgElevated,
          border: `1px solid ${COLORS.bgDeepest}`,
        }}
      >
        {/* resize-y: native vertical grab handle (bottom-right). min/max keep
            it usable — tall enough for multi-paragraph prompts, never taller
            than half the viewport. */}
        <textarea
          ref={taRef}
          value={draft}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={handleKey}
          placeholder={placeholder}
          rows={2}
          className="max-h-[50vh] min-h-[60px] w-full resize-y bg-transparent text-[13px] leading-snug focus:outline-none"
          style={{ color: COLORS.textPrimary }}
        />
        <div className="mt-1.5 flex items-center gap-1.5">
          <input
            id={fileInputId}
            type="file"
            multiple
            accept={acceptedTypes}
            onChange={onPicked}
            disabled={!onAttach || isUploading}
            className="sr-only"
            data-testid="party-file-input"
          />
          <label
            htmlFor={fileInputId}
            title={
              !onAttach
                ? 'Attach unavailable — open a session to upload docs'
                : isUploading
                  ? 'Uploading…'
                  : 'Attach a file for this debate (.md, .pdf, .txt, .json, .csv, .yaml — 10 MiB max)'
            }
            aria-disabled={!onAttach || isUploading}
            className="flex h-7 w-7 cursor-pointer items-center justify-center rounded-md transition-colors aria-disabled:cursor-not-allowed aria-disabled:opacity-60 hover:bg-white/5"
            style={{ color: COLORS.textMuted }}
          >
            {isUploading ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Paperclip className="h-3.5 w-3.5" />
            )}
          </label>
          <IconBtn title="Mention agent">
            <AtSign className="h-3.5 w-3.5" />
          </IconBtn>
          <span className="flex-1" />
          <button
            type="button"
            onClick={onSend}
            disabled={!draft.trim()}
            className="inline-flex items-center gap-1 rounded-[6px] px-3 py-1.5 text-[12px] font-medium text-white transition-colors disabled:cursor-not-allowed disabled:opacity-50"
            style={{ background: COLORS.accentBrand }}
          >
            Send <ArrowRight className="h-3 w-3" />
          </button>
        </div>
      </div>
    </div>
  );
}

function IconBtn({
  title,
  children,
  onClick,
  disabled = false,
}: {
  title: string;
  children: React.ReactNode;
  onClick?: () => void;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      title={title}
      onClick={onClick}
      disabled={disabled}
      className="flex h-7 w-7 items-center justify-center rounded-md transition-colors disabled:cursor-not-allowed disabled:opacity-60"
      style={{ color: COLORS.textMuted }}
      onMouseEnter={(e) => {
        if (disabled) return;
        e.currentTarget.style.background = 'color-mix(in srgb, var(--foreground) 5%, transparent)';
        e.currentTarget.style.color = COLORS.textPrimary;
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.background = 'transparent';
        e.currentTarget.style.color = COLORS.textMuted;
      }}
    >
      {children}
    </button>
  );
}
