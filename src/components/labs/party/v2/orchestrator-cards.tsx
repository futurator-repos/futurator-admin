'use client';
import { RichText } from '../rich-text';
import { CopyButton } from './copy-button';
import { COLORS } from './tokens';
import { ToolLog } from './tool-log';
import type { ToolCall } from '../turn-adapter';

/**
 * Orchestrator open container — the round's "intro" card.
 * Spec §6.2. Strong purple gradient header band, distinct from agent cards.
 *
 * If `tools` is non-empty, renders a collapsible "Actions" log inside the
 * card so the user can see what the orchestrator is exploring (Read, Glob,
 * Bash, etc.) — both as a progress signal during cold-start and as a
 * debugging aid afterwards.
 */
export function OrchestratorOpen({
  text,
  agentCount,
  streaming = false,
  tools = [],
  toolsDefaultOpen = false,
}: {
  text: string;
  agentCount?: number;
  streaming?: boolean;
  tools?: ToolCall[];
  toolsDefaultOpen?: boolean;
}) {
  return (
    <div
      className="relative mx-6 mb-3 overflow-hidden rounded-[14px]"
      style={{
        background:
          'linear-gradient(180deg, rgba(167,139,250,0.18), rgba(167,139,250,0.05))',
        border: `1px solid rgba(167,139,250,0.4)`,
      }}
    >
      <div
        className="flex items-center gap-3 px-4 py-3"
        style={{
          background: 'rgba(167,139,250,0.12)',
          borderBottom: '1px solid rgba(167,139,250,0.25)',
        }}
      >
        <div
          className="flex shrink-0 items-center justify-center rounded-full"
          style={{
            width: 32,
            height: 32,
            background: 'rgba(167,139,250,0.25)',
            border: `2px solid ${COLORS.accentOrch}`,
          }}
        >
          <span style={{ fontSize: 18, lineHeight: 1 }}>🧙</span>
        </div>
        <div className="min-w-0 flex-1">
          <div
            className="text-[13px] font-bold uppercase leading-tight tracking-[0.06em]"
            style={{ color: COLORS.accentOrchSoft }}
          >
            Orchestrator · BMad Master sets the round
          </div>
          {typeof agentCount === 'number' && (
            <div className="text-[12px]" style={{ color: '#a89fc4' }}>
              {agentCount} agent{agentCount === 1 ? '' : 's'} weighing in
            </div>
          )}
        </div>
        <CopyButton text={text} label="orchestrator opening" />
      </div>
      <div
        className="px-5 py-4 text-[14.5px] leading-[1.55]"
        style={{ color: COLORS.textBody }}
      >
        {text && <RichText text={text} />}
        {streaming && (
          <span
            className="party-stream-cursor"
            style={{ background: COLORS.accentOrch }}
          />
        )}
        {tools.length > 0 && <ToolLog tools={tools} defaultOpen={toolsDefaultOpen} />}
      </div>
    </div>
  );
}

/**
 * Orchestrator close container — softer than the opener.
 * Spec §6.5. Used for the closing summary / hand-off question at end of round.
 */
export function OrchestratorClose({ text, n }: { text: string; n?: number }) {
  return (
    <div
      className="relative mx-6 mb-3 overflow-hidden rounded-[14px]"
      style={{
        background: 'rgba(167,139,250,0.05)',
        border: `1px solid rgba(167,139,250,0.25)`,
      }}
    >
      <div
        className="flex items-center gap-3 px-4 py-2.5"
        style={{
          background: 'rgba(167,139,250,0.07)',
          borderBottom: '1px solid rgba(167,139,250,0.18)',
        }}
      >
        <div
          className="flex shrink-0 items-center justify-center rounded-full"
          style={{
            width: 28,
            height: 28,
            background: 'rgba(167,139,250,0.18)',
            border: `1px solid ${COLORS.accentOrch}`,
          }}
        >
          <span style={{ fontSize: 14, lineHeight: 1 }}>🧙</span>
        </div>
        <div
          className="text-[12px] font-bold uppercase tracking-[0.06em]"
          style={{ color: COLORS.accentOrchSoft }}
        >
          Orchestrator{typeof n === 'number' ? ` · closes Round ${n}` : ''}
        </div>
        <span className="ml-auto">
          <CopyButton text={text} label="orchestrator closing" />
        </span>
      </div>
      <div
        className="px-5 py-3.5 text-[14px] leading-[1.55]"
        style={{ color: COLORS.textBody }}
      >
        <RichText text={text} />
      </div>
    </div>
  );
}

/**
 * Mid-round orchestrator note — small interjection between agents.
 * Spec §6.4. Appears with a soft fade-in.
 */
export function OrchestratorMidNote({
  text,
  eyebrow,
}: {
  text: string;
  eyebrow?: string;
}) {
  return (
    <div
      className="party-mid-note ml-[76px] mr-12 mb-3 rounded-[10px] px-3.5 py-2.5"
      style={{
        background: 'rgba(167,139,250,0.06)',
        border: '1px solid rgba(167,139,250,0.2)',
      }}
    >
      <div className="flex items-center gap-2">
        <div
          className="flex shrink-0 items-center justify-center rounded-full"
          style={{
            width: 22,
            height: 22,
            background: 'rgba(167,139,250,0.2)',
            border: `1px solid ${COLORS.accentOrch}`,
          }}
        >
          <span style={{ fontSize: 11 }}>🧙</span>
        </div>
        {eyebrow && (
          <span
            className="text-[11px] font-semibold uppercase tracking-[0.06em]"
            style={{ color: COLORS.accentOrch }}
          >
            {eyebrow}
          </span>
        )}
      </div>
      <div
        className="mt-1.5 text-[13px] italic leading-[1.55]"
        style={{ color: COLORS.textBody }}
      >
        <RichText text={text} />
      </div>
    </div>
  );
}

/**
 * User question banner — top of each round in the main pane.
 * Spec §6.1. Uses the signed-in user's name + initial (and avatar picture
 * if OAuth provided one) so the conversation reads as theirs, not as a
 * generic "USER ASKED".
 */
export function UserQuestionBanner({
  text,
  timestamp,
  userName = 'You',
  userInitial = 'U',
  userPicture,
}: {
  text: string;
  timestamp?: string;
  userName?: string;
  userInitial?: string;
  userPicture?: string;
}) {
  return (
    <div
      className="mx-6 mb-4 mt-2 flex items-start gap-3 rounded-[10px] px-4 py-3"
      style={{ background: 'rgba(255,255,255,0.03)' }}
    >
      {userPicture ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={userPicture}
          alt={userName}
          className="shrink-0 rounded-full"
          style={{ width: 28, height: 28, objectFit: 'cover' }}
        />
      ) : (
        <div
          className="flex shrink-0 items-center justify-center rounded-full text-[12px] font-bold uppercase text-white"
          style={{ width: 28, height: 28, background: COLORS.accentBrand }}
        >
          {userInitial}
        </div>
      )}
      <div className="min-w-0 flex-1">
        <div
          className="text-[12px] font-semibold tracking-[0.04em]"
          style={{ color: COLORS.textMuted }}
        >
          <span style={{ color: COLORS.textPrimary }}>{userName}</span>
          {timestamp ? ` · ${timestamp}` : ''}
        </div>
        <div
          className="mt-0.5 whitespace-pre-wrap text-[14px] leading-[1.55]"
          style={{ color: COLORS.textPrimary }}
        >
          {text}
        </div>
      </div>
    </div>
  );
}

/**
 * Skeleton placeholder for the cold-start window (5–20s waiting on Claude).
 * Three shimmer cards so the user sees something immediately.
 */
export function AgentCardSkeleton() {
  return (
    <div
      className="relative mx-6 mb-3 overflow-hidden rounded-xl"
      style={{ background: COLORS.bgSurface }}
    >
      <div style={{ height: 4, background: 'rgba(255,255,255,0.08)' }} />
      <div className="flex items-start gap-3 px-4 pt-3.5 pb-3.5">
        <div
          className="party-shimmer shrink-0 rounded-[14px]"
          style={{ width: 48, height: 48 }}
        />
        <div className="min-w-0 flex-1 space-y-2">
          <div className="party-shimmer h-4 w-1/3 rounded" />
          <div className="party-shimmer h-3 w-2/3 rounded" />
          <div className="party-shimmer h-3 w-1/2 rounded" />
        </div>
      </div>
    </div>
  );
}
