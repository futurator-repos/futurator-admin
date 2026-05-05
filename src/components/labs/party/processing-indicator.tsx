'use client';
import { Avatar } from './avatar';
import { agentIdentity } from './agent-identity';

export type StageState = 'pending' | 'running' | 'done';

export interface StageLine {
  text: string;
  state: StageState;
}

interface Props {
  stage?: string;
  activeAgent?: string | null;
  lines?: StageLine[];
}

export function ProcessingIndicator({ stage, activeAgent, lines = [] }: Props) {
  const activeId = activeAgent ? agentIdentity(activeAgent) : null;
  return (
    <div
      className="rounded-lg border border-border px-3.5 py-3 flex flex-col gap-2.5"
      style={{ background: 'linear-gradient(180deg, color-mix(in srgb, var(--success) 4%, transparent) 0%, transparent 100%)' }}
    >
      <div className="flex items-center gap-2.5">
        <div className="relative h-[22px] w-[22px]">
          <svg width="22" height="22" viewBox="0 0 22 22" aria-hidden="true">
            <circle cx="11" cy="11" r="9" fill="none" stroke="var(--border)" strokeWidth="2" />
            <circle
              cx="11"
              cy="11"
              r="9"
              fill="none"
              stroke="var(--success)"
              strokeWidth="2"
              strokeDasharray="14 42"
              strokeLinecap="round"
              transform="rotate(-90 11 11)"
            >
              <animateTransform
                attributeName="transform"
                type="rotate"
                from="-90 11 11"
                to="270 11 11"
                dur="1.2s"
                repeatCount="indefinite"
              />
            </circle>
          </svg>
        </div>
        <div className="flex-1 text-[13px] font-mono">
          <span className="text-success">●</span>{' '}
          <span className="party-soft-pulse">{stage || 'Party agents are thinking…'}</span>
        </div>
        {activeAgent && activeId && (
          <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
            <Avatar speaker={activeAgent} size={20} />
            <span>
              <strong style={{ color: activeId.accentHex }}>{activeAgent}</strong> is composing…
            </span>
          </div>
        )}
      </div>

      {lines.length > 0 && (
        <div className="flex flex-col gap-1 pl-0.5 font-mono text-[11.5px] text-muted-foreground">
          {lines.map((line, i) => (
            <div key={i} className="flex items-center gap-2">
              <span
                className={`w-2.5 inline-block ${
                  line.state === 'done'
                    ? 'text-success'
                    : line.state === 'running'
                      ? 'text-warning'
                      : 'text-muted-foreground/60'
                }`}
              >
                {line.state === 'done' ? '✓' : line.state === 'running' ? '›' : '·'}
              </span>
              <span
                className={
                  line.state === 'done'
                    ? 'text-muted-foreground'
                    : line.state === 'pending'
                      ? 'text-muted-foreground/60'
                      : 'text-foreground'
                }
              >
                {line.text}
              </span>
              {line.state === 'running' && (
                <span className="ml-1 text-warning">
                  <span className="party-typing-dot" />
                  <span className="party-typing-dot" />
                  <span className="party-typing-dot" />
                </span>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
