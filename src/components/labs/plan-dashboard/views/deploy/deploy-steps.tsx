'use client';

/**
 * Live deploy step tracker. Shows the 4 pipeline stages (build → sync →
 * invalidate → verify) with per-step status. The backend projects a single
 * deploy job onto 4 display steps; when we migrate to per-step jobs this
 * component renders finer-grained signals automatically.
 */

import type { DeployRecord, DeployStepStatus } from '@/types/deploy-report';

const STATUS_META: Record<DeployStepStatus['status'], { color: string; glyph: string }> = {
  pass: { color: 'var(--success)', glyph: '✓' },
  running: { color: 'var(--accent-purple)', glyph: '●' },
  fail: { color: 'var(--destructive)', glyph: '✗' },
  pending: { color: 'var(--text-faint)', glyph: '○' },
  skipped: { color: 'var(--text-faint)', glyph: '—' },
};

export function DeploySteps({ current }: { current: DeployRecord | null }) {
  if (!current) {
    return (
      <div
        style={{
          padding: '24px 18px',
          border: '1px solid var(--border)',
          background: 'var(--bg-elev)',
          borderRadius: 8,
          color: 'var(--text-mute)',
          fontSize: 12,
          textAlign: 'center',
        }}
      >
        No deploy has run yet. Click <strong>Deploy to production</strong> to ship.
      </div>
    );
  }
  return (
    <div
      style={{
        border: '1px solid var(--border)',
        background: 'var(--bg-elev)',
        borderRadius: 8,
        overflow: 'hidden',
      }}
    >
      <div
        style={{
          padding: '12px 18px',
          borderBottom: '1px solid var(--border)',
          display: 'flex',
          alignItems: 'center',
          gap: 12,
        }}
      >
        <span
          style={{
            fontFamily: 'var(--font-mono)',
            fontSize: 9,
            color: 'var(--text-faint)',
            textTransform: 'uppercase',
            letterSpacing: '0.22em',
          }}
        >
          {current.status === 'PENDING' || current.status === 'RUNNING'
            ? 'Deploy in progress'
            : 'Last deploy'}
        </span>
        <span
          style={{
            fontFamily: 'var(--font-mono)',
            fontSize: 10,
            color: 'var(--text-mute)',
            letterSpacing: '0.06em',
          }}
        >
          {fmtDuration(current.durationSec)} · job {current.jobId.slice(0, 8)}
        </span>
      </div>
      <ol style={{ listStyle: 'none', margin: 0, padding: 0 }}>
        {current.steps.map((step, i) => {
          const meta = STATUS_META[step.status];
          return (
            <li
              key={step.id}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 12,
                padding: '12px 18px',
                borderTop: i === 0 ? 'none' : '1px solid var(--border)',
              }}
            >
              <span
                className={step.status === 'running' ? 'animate-pulse-soft' : ''}
                style={{
                  width: 20,
                  height: 20,
                  borderRadius: '50%',
                  background: `color-mix(in srgb, ${meta.color} 14%, transparent)`,
                  border: `1px solid ${meta.color}`,
                  color: meta.color,
                  display: 'inline-flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  fontFamily: 'var(--font-mono)',
                  fontSize: 10,
                  fontWeight: 600,
                  flexShrink: 0,
                }}
              >
                {meta.glyph}
              </span>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div
                  style={{
                    fontSize: 13,
                    color: 'var(--foreground)',
                    fontWeight: 500,
                    letterSpacing: '-0.005em',
                  }}
                >
                  {step.label}
                </div>
                {step.detail && (
                  <div
                    style={{
                      fontFamily: 'var(--font-mono)',
                      fontSize: 10,
                      color: 'var(--text-mute)',
                      marginTop: 3,
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                      letterSpacing: '0.02em',
                    }}
                  >
                    {step.detail}
                  </div>
                )}
              </div>
              <span
                style={{
                  fontFamily: 'var(--font-mono)',
                  fontSize: 9,
                  color: meta.color,
                  textTransform: 'uppercase',
                  letterSpacing: '0.18em',
                  flexShrink: 0,
                }}
              >
                {step.status}
              </span>
            </li>
          );
        })}
      </ol>
      {current.status === 'FAILED' && current.errorMessage && (
        <div
          style={{
            padding: '12px 18px',
            borderTop: '1px solid var(--destructive)',
            background: 'color-mix(in srgb, var(--destructive) 10%, transparent)',
            color: 'var(--destructive)',
            fontSize: 12,
            fontFamily: 'var(--font-mono)',
            letterSpacing: '0.04em',
          }}
        >
          {current.errorMessage}
        </div>
      )}
    </div>
  );
}

function fmtDuration(s: number | undefined): string {
  if (s == null || !Number.isFinite(s)) return '—';
  if (s < 60) return `${Math.round(s)}s`;
  const m = Math.floor(s / 60);
  const r = Math.round(s % 60);
  return `${m}m ${r}s`;
}
