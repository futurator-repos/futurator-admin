'use client';
import { agentIdentity } from '../agent-identity';
import { RichText } from '../rich-text';
import { CopyButton } from './copy-button';
import { COLORS } from './tokens';

/**
 * Agent message card — Discord-leaning, Slack-readable.
 * Spec: `docs/concepts/party-mode/party-mode-ui2.md` §6.3.
 *
 * Visual structure:
 *   • 4 px top edge in agent's accent color (the identity strip)
 *   • 48 px square avatar with status dot
 *   • Name (16 px bold) + role pill + timestamp + copy button on the right
 *   • Body indented to align with avatar gutter (76 px = 48 avatar + 12 gap + 16 padding)
 */
export function AgentCard({
  speaker,
  text,
  streaming = false,
  timestamp,
}: {
  speaker: string;
  text: string;
  streaming?: boolean;
  timestamp?: string;
}) {
  const id = agentIdentity(speaker);
  const time = timestamp || 'just now';

  return (
    <div
      className="relative mx-6 mb-3 overflow-hidden rounded-xl"
      style={{ background: COLORS.bgSurface }}
    >
      {/* Top accent edge — the identity strip */}
      <div style={{ height: 4, background: id.accentHex }} />

      <div className="px-4 pt-3.5 pb-3.5">
        <div className="flex items-start gap-3">
          {/* Avatar */}
          <div className="relative shrink-0">
            <div
              className="flex items-center justify-center rounded-[14px]"
              style={{
                width: 48,
                height: 48,
                background: id.bg,
                border: `2px solid ${id.accentHex}`,
                color: id.accentHex,
              }}
              title={id.title ? `${speaker} · ${id.title}` : speaker}
            >
              <span style={{ fontSize: 24, lineHeight: 1 }}>
                {id.icon || id.fallbackInitials}
              </span>
            </div>
            {/* Status dot */}
            <span
              className="absolute"
              style={{
                bottom: -2,
                right: -2,
                width: 14,
                height: 14,
                borderRadius: 7,
                background: streaming ? COLORS.accentLive : '#80848e',
                border: `2px solid ${COLORS.bgSurface}`,
              }}
            />
          </div>

          {/* Header + body */}
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <span
                className="text-[16px] font-bold leading-tight"
                style={{ color: COLORS.textPrimary }}
              >
                {speaker}
              </span>
              {id.title && (
                <span
                  className="rounded-[10px] px-2 py-[2px] text-[12px] font-semibold leading-none"
                  style={{ background: `${id.accentHex}38`, color: id.accentHex }}
                >
                  {id.title}
                </span>
              )}
              <span className="ml-auto flex items-center gap-2">
                <span className="text-[12px]" style={{ color: COLORS.textMuted }}>
                  {time}
                </span>
                <CopyButton text={text} label={`${speaker}'s message`} />
              </span>
            </div>

            <div className="mt-2 text-[14.5px] leading-[1.55]">
              <RichText text={text} />
              {streaming && <StreamingDots accent={id.accentHex} />}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

/**
 * Three pulsing dots in agent accent — shown beneath the last block when
 * a round is active and this is the most recent agent. Spec §12.
 */
function StreamingDots({ accent }: { accent: string }) {
  return (
    <div className="mt-2 flex items-center gap-1.5" aria-label="Streaming">
      {[0, 0.18, 0.36].map((delay, i) => (
        <span
          key={i}
          className="party-typing-dot"
          style={
            {
              background: accent,
              animationDelay: `${delay}s`,
            } as React.CSSProperties
          }
        />
      ))}
    </div>
  );
}
