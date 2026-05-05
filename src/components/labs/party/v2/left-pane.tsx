'use client';
import { useId, useState, useRef, useEffect, type KeyboardEvent } from 'react';
import { ArrowRight, Paperclip, AtSign, Hash, Loader2, MessageSquare } from 'lucide-react';
import { COLORS } from './tokens';
import type { Round } from '../turn-adapter';
import { timeAgo } from '../turn-adapter';

type LeftTab = 'chat' | 'sessions';

export interface LeftPaneSession {
  sessionId: string;
  topic?: string;
  status: string;
  turnCount: number;
  lastTurnAt?: string;
  createdAt: string;
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
  /** Optional sessions list for the Sessions tab. */
  sessions?: LeftPaneSession[];
  activeSessionId?: string | null;
  onPickSession?: (sessionId: string) => void;
  onNewSession?: () => void;
}

/**
 * Left pane — tabs (Chat / Sessions) + composer pinned to the bottom.
 * Spec §5. The Chat tab is a per-round-grouped feed of user messages and
 * the orchestrator system bubbles. The Sessions tab lists prior sessions.
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
  sessions,
  activeSessionId,
  onPickSession,
  onNewSession,
}: Props) {
  const [tab, setTab] = useState<LeftTab>('chat');
  return (
    <div
      className="flex h-full flex-col"
      style={{ background: COLORS.bgSurface }}
    >
      <Tabs tab={tab} onChange={setTab} />

      <div className="flex-1 overflow-y-auto">
        {tab === 'chat' && <ChatHistory rounds={rounds} activeRoundId={activeRoundId} />}
        {tab === 'sessions' && (
          <SessionsList
            sessions={sessions ?? []}
            activeSessionId={activeSessionId ?? null}
            onPick={onPickSession}
            onNew={onNewSession}
          />
        )}
      </div>

      {tab === 'chat' && (
        <ComposerBar
          draft={draft}
          onChange={onDraftChange}
          onSend={onSend}
          isProcessing={isProcessing}
          isErrored={isErrored}
          onAttach={onAttach}
          isUploading={isUploading}
          acceptedTypes={acceptedTypes}
        />
      )}
    </div>
  );
}

function Tabs({ tab, onChange }: { tab: LeftTab; onChange: (t: LeftTab) => void }) {
  return (
    <div
      className="flex shrink-0 items-end gap-4 px-4"
      style={{
        height: 56,
        borderBottom: `1px solid ${COLORS.bgDeepest}`,
      }}
    >
      <TabBtn
        active={tab === 'chat'}
        onClick={() => onChange('chat')}
        icon={<MessageSquare className="h-3.5 w-3.5" />}
        label="Chat"
      />
      <TabBtn
        active={tab === 'sessions'}
        onClick={() => onChange('sessions')}
        icon={<Hash className="h-3.5 w-3.5" />}
        label="Sessions"
      />
    </div>
  );
}

function TabBtn({
  active,
  onClick,
  icon,
  label,
}: {
  active: boolean;
  onClick: () => void;
  icon: React.ReactNode;
  label: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="-mb-[1px] flex items-center gap-1.5 border-b-2 pb-2.5 text-[13px] transition-colors"
      style={{
        borderColor: active ? COLORS.accentBrand : 'transparent',
        color: active ? COLORS.textPrimary : COLORS.textMuted,
        fontWeight: active ? 600 : 500,
      }}
    >
      {icon}
      {label}
    </button>
  );
}

/** Chat tab body — round-grouped history of user messages + system summaries. */
function ChatHistory({
  rounds,
  activeRoundId,
}: {
  rounds: Round[];
  activeRoundId: string | null;
}) {
  const ref = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (ref.current) ref.current.scrollTop = ref.current.scrollHeight;
  }, [rounds.length, activeRoundId]);

  if (rounds.length === 0) {
    return (
      <div
        className="m-4 rounded-md border border-dashed px-3 py-6 text-center text-[12px] italic"
        style={{ borderColor: COLORS.bgDeepest, color: COLORS.textMuted }}
      >
        Start a debate by sending a message below. Each round groups your
        question + the agents&apos; responses.
      </div>
    );
  }
  return (
    <div ref={ref} className="px-3 py-3">
      {rounds.map((r) => (
        <div key={r.id} className="mb-3">
          <RoundDivider n={r.n} title={r.user.text} />
          {r.speakers.length > 0 && (
            <SystemBubble
              text={`Round ${r.n} started → ${r.speakers.join(', ')}`}
            />
          )}
          <UserBubble text={r.user.text} timestamp={timeAgo(r.startedAt)} />
          {r.status === 'done' && r.turns > 0 && (
            <SystemBubble
              text={`Round ${r.n} closed · ${r.turns} contribution${r.turns === 1 ? '' : 's'} captured.`}
            />
          )}
          {r.status === 'awaiting' && (
            <SystemBubble text={`An agent asked you a follow-up — reply below.`} />
          )}
          {r.status === 'error' && (
            <SystemBubble text={`Round ${r.n} failed${r.errorReason ? ` (${r.errorReason})` : ''}.`} />
          )}
        </div>
      ))}
    </div>
  );
}

function RoundDivider({ n, title }: { n: number; title: string }) {
  const short = title.length > 60 ? `${title.slice(0, 60)}…` : title;
  return (
    <div className="my-3 flex items-center gap-2">
      <div className="h-px flex-1" style={{ background: COLORS.bgDeepest }} />
      <span
        className="text-[10px] font-mono font-semibold uppercase tracking-wider"
        style={{ color: COLORS.textFaint }}
      >
        Round {n} · {short || 'untitled'}
      </span>
      <div className="h-px flex-1" style={{ background: COLORS.bgDeepest }} />
    </div>
  );
}

function SystemBubble({ text }: { text: string }) {
  return (
    <div
      className="my-1 rounded-md px-2.5 py-1.5 text-[12px] italic"
      style={{
        background: 'rgba(167,139,250,0.1)',
        color: COLORS.accentOrchSoft,
      }}
    >
      🧙 {text}
    </div>
  );
}

function UserBubble({ text, timestamp }: { text: string; timestamp: string }) {
  return (
    <div className="my-1 flex flex-col items-end">
      <div
        className="max-w-[85%] whitespace-pre-wrap rounded-[14px] rounded-br-[4px] px-3 py-2 text-[13px] leading-snug text-white"
        style={{ background: COLORS.accentBrand }}
      >
        {text}
      </div>
      <span
        className="mt-0.5 text-[10px]"
        style={{ color: COLORS.textFaint }}
      >
        {timestamp}
      </span>
    </div>
  );
}

function SessionsList({
  sessions,
  activeSessionId,
  onPick,
  onNew,
}: {
  sessions: LeftPaneSession[];
  activeSessionId: string | null;
  onPick?: (id: string) => void;
  onNew?: () => void;
}) {
  return (
    <div className="px-3 py-3 space-y-3">
      {onNew && (
        <button
          type="button"
          onClick={onNew}
          className="w-full rounded-md border px-3 py-2 text-left text-[12px] transition-colors"
          style={{
            borderColor: COLORS.bgDeepest,
            color: COLORS.textPrimary,
            background: COLORS.bgElevated,
          }}
        >
          + New session
        </button>
      )}

      <SessionGroupHeader label="Active" />
      {sessions
        .filter((s) => s.status !== 'ARCHIVED')
        .map((s) => (
          <SessionRow
            key={s.sessionId}
            session={s}
            active={s.sessionId === activeSessionId}
            onClick={onPick ? () => onPick(s.sessionId) : undefined}
          />
        ))}
      {sessions.filter((s) => s.status === 'ARCHIVED').length > 0 && (
        <>
          <SessionGroupHeader label="Archived" />
          {sessions
            .filter((s) => s.status === 'ARCHIVED')
            .map((s) => (
              <SessionRow
                key={s.sessionId}
                session={s}
                active={s.sessionId === activeSessionId}
                onClick={onPick ? () => onPick(s.sessionId) : undefined}
              />
            ))}
        </>
      )}
      {sessions.length === 0 && (
        <div
          className="rounded-md border border-dashed px-3 py-4 text-center text-[12px] italic"
          style={{ borderColor: COLORS.bgDeepest, color: COLORS.textMuted }}
        >
          No prior sessions for this project.
        </div>
      )}
    </div>
  );
}

function SessionGroupHeader({ label }: { label: string }) {
  return (
    <div
      className="px-2 text-[10px] font-mono font-semibold uppercase tracking-wider"
      style={{ color: COLORS.textFaint }}
    >
      {label}
    </div>
  );
}

function SessionRow({
  session,
  active,
  onClick,
}: {
  session: LeftPaneSession;
  active: boolean;
  onClick?: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="w-full rounded-md px-2.5 py-1.5 text-left transition-colors"
      style={{
        background: active ? '#404249' : 'transparent',
      }}
      onMouseEnter={(e) => {
        if (!active) e.currentTarget.style.background = 'rgba(255,255,255,0.03)';
      }}
      onMouseLeave={(e) => {
        if (!active) e.currentTarget.style.background = 'transparent';
      }}
    >
      <div className="flex items-center gap-2">
        <Hash className="h-3 w-3 shrink-0" style={{ color: COLORS.textMuted }} />
        <span
          className="truncate text-[12.5px]"
          style={{ color: active ? COLORS.textPrimary : COLORS.textBody }}
        >
          {session.topic || `session-${session.sessionId.slice(0, 6)}`}
        </span>
      </div>
      <div className="mt-0.5 flex items-center gap-2 pl-5 text-[10px]" style={{ color: COLORS.textFaint }}>
        <span>{session.turnCount} turn{session.turnCount === 1 ? '' : 's'}</span>
        <span>·</span>
        <span>{timeAgo(session.lastTurnAt ?? session.createdAt)}</span>
      </div>
    </button>
  );
}

function ComposerBar({
  draft,
  onChange,
  onSend,
  isProcessing,
  isErrored,
  onAttach,
  isUploading,
  acceptedTypes,
}: {
  draft: string;
  onChange: (v: string) => void;
  onSend: () => void;
  isProcessing: boolean;
  isErrored: boolean;
  onAttach?: (files: File[]) => void;
  isUploading?: boolean;
  acceptedTypes?: string;
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
    if (!onAttach) {
      console.warn('[Party] file picked but onAttach is not wired (no project scope?)');
      return;
    }
    console.log('[Party] file picker selected', files.length, 'file(s):', files.map((f) => f.name));
    if (files.length) onAttach(files);
  }

  const placeholder = isProcessing
    ? 'Ask a follow-up while the debate runs…'
    : isErrored
      ? 'Session errored. Type a new message to start a fresh round…'
      : 'Type a message — agents will respond';

  return (
    <div className="shrink-0 px-3 py-3">
      {isErrored && (
        <div
          className="mb-2 rounded-md px-2.5 py-1.5 text-[11px]"
          style={{
            background: 'rgba(248,113,113,0.1)',
            color: '#fca5a5',
            border: '1px solid rgba(248,113,113,0.3)',
          }}
        >
          Last turn ended in ERROR (likely a timeout — agents take time on
          large projects). Send a new message to start a fresh round; the
          previous round&apos;s partial output is preserved above.
        </div>
      )}
      <div
        className="rounded-[10px] p-2.5"
        style={{
          background: COLORS.bgElevated,
          border: `1px solid ${COLORS.bgDeepest}`,
        }}
      >
        <textarea
          ref={taRef}
          value={draft}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={handleKey}
          placeholder={placeholder}
          rows={2}
          className="min-h-[60px] w-full resize-none bg-transparent text-[13px] leading-snug focus:outline-none"
          style={{ color: COLORS.textPrimary }}
        />
        <div className="mt-1.5 flex items-center gap-1.5">
          {/* sr-only file input + matching <label> — most reliable cross-browser
              file-picker trigger (no JS ref.click() quirks). */}
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
                  : 'Attach a file (.md, .pdf, .txt, .json, .csv, .yaml — 10 MiB max)'
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
        e.currentTarget.style.background = 'rgba(255,255,255,0.04)';
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
