'use client';
import { agentIdentity } from '../agent-identity';
import { COLORS } from './tokens';
import type { Round } from '../turn-adapter';
import { timeAgo } from '../turn-adapter';

/**
 * Right pane — list of rounds for this session.
 * Spec §7. One card per round; click to swap the main pane.
 */
export function RoundRail({
  rounds,
  activeRoundId,
  onSelect,
}: {
  rounds: Round[];
  activeRoundId: string | null;
  onSelect: (roundId: string) => void;
}) {
  // Reverse so most-recent is at the top.
  const ordered = [...rounds].reverse();
  return (
    <div
      className="flex h-full flex-col"
      style={{ background: COLORS.bgSurface }}
    >
      <div
        className="flex shrink-0 items-center justify-between px-4"
        style={{
          height: 56,
          borderBottom: `1px solid ${COLORS.bgDeepest}`,
        }}
      >
        <span
          className="text-[14px] font-semibold"
          style={{ color: COLORS.textPrimary }}
        >
          Rounds
        </span>
        <span
          className="text-[12px]"
          style={{ color: COLORS.textMuted }}
        >
          {rounds.length} total
        </span>
      </div>

      <div className="flex-1 space-y-2 overflow-y-auto px-3 py-3">
        {ordered.length === 0 && (
          <div
            className="rounded-md border border-dashed px-3 py-4 text-center text-[12px]"
            style={{
              borderColor: COLORS.bgDeepest,
              color: COLORS.textMuted,
            }}
          >
            No rounds yet — send a message to start.
          </div>
        )}

        {ordered.map((r) => (
          <RoundCard
            key={r.id}
            round={r}
            active={r.id === activeRoundId}
            onClick={() => onSelect(r.id)}
          />
        ))}
      </div>
    </div>
  );
}

function RoundCard({
  round,
  active,
  onClick,
}: {
  round: Round;
  active: boolean;
  onClick: () => void;
}) {
  const live = round.isInflight;
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className="block w-full rounded-[10px] border px-3 py-2.5 text-left transition-colors"
      style={{
        background: active ? 'rgba(88,101,242,0.12)' : 'rgba(255,255,255,0.02)',
        borderColor: active
          ? 'rgba(88,101,242,0.4)'
          : 'rgba(255,255,255,0.06)',
        color: COLORS.textBody,
      }}
    >
      <div className="flex items-center gap-2">
        {live ? (
          <span
            className="inline-flex items-center gap-1 rounded-[10px] px-2 py-[2px] text-[10px] font-bold uppercase tracking-wider"
            style={{
              background: 'rgba(74,222,128,0.18)',
              color: COLORS.accentLive,
              border: '1px solid rgba(74,222,128,0.4)',
            }}
          >
            <span
              className="h-1.5 w-1.5 rounded-full"
              style={{ background: COLORS.accentLive }}
            />
            Round {round.n}
          </span>
        ) : (
          <span
            className="inline-flex items-center rounded-[10px] px-2 py-[2px] text-[10px] font-bold uppercase tracking-wider"
            style={{
              background: 'rgba(255,255,255,0.06)',
              color: COLORS.textMuted,
            }}
          >
            Round {round.n}
          </span>
        )}
        <span
          className="ml-auto text-[11px]"
          style={{ color: COLORS.textMuted }}
        >
          {live ? 'now' : timeAgo(round.startedAt)}
        </span>
      </div>

      <div
        className="mt-2 line-clamp-2 text-[13px] font-semibold leading-snug"
        style={{ color: COLORS.textPrimary }}
      >
        {round.user.text || 'Untitled round'}
      </div>

      {round.speakers.length > 0 && (
        <div className="mt-2 flex items-center">
          {round.speakers.slice(0, 6).map((speaker, idx) => {
            const id = agentIdentity(speaker);
            return (
              <span
                key={`${speaker}-${idx}`}
                className="flex items-center justify-center rounded-full"
                style={{
                  width: 22,
                  height: 22,
                  background: id.bg,
                  border: `2px solid ${COLORS.bgSurface}`,
                  color: id.accentHex,
                  marginLeft: idx === 0 ? 0 : -4,
                  zIndex: 10 - idx,
                }}
                title={speaker}
              >
                <span style={{ fontSize: 10, lineHeight: 1 }}>{id.icon || id.fallbackInitials}</span>
              </span>
            );
          })}
          {round.speakers.length > 6 && (
            <span
              className="ml-1 text-[11px]"
              style={{ color: COLORS.textMuted }}
            >
              +{round.speakers.length - 6}
            </span>
          )}
        </div>
      )}

      <div
        className="mt-1.5 text-[11px]"
        style={{ color: COLORS.textMuted }}
      >
        {round.speakers.length} agent{round.speakers.length === 1 ? '' : 's'} ·{' '}
        {round.turns} turn{round.turns === 1 ? '' : 's'}
      </div>
    </button>
  );
}
