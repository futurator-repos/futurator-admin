'use client';

/**
 * ReleaseHistory — compact strip of the last few deploys (design doc U5
 * "release history strip"). A trimmed, labs3-native sibling of the legacy
 * `plan-dashboard/views/deploy/deploy-history.tsx` (not imported directly —
 * that file isn't in this slice's reuse allowlist, so the row idiom is
 * re-implemented here rather than editing/importing it). No rollback action —
 * this is a read-only history line, not a control surface.
 */

import { ExternalLink } from 'lucide-react';
import type { DeployRecord } from '@/types/deploy-report';
import { isTerminalDeploySuccess } from '@/types/deploy-report';

const MAX_ROWS = 5;

export function ReleaseHistory({ history }: { history: DeployRecord[] }) {
  const rows = history.slice(0, MAX_ROWS);

  return (
    <section
      aria-label="Release history"
      style={{
        border: '1px solid var(--border)',
        background: 'var(--bg-elev)',
        borderRadius: 10,
        overflow: 'hidden',
      }}
    >
      <header
        style={{
          padding: '12px 18px',
          borderBottom: '1px solid var(--border)',
          fontFamily: 'var(--font-mono)',
          fontSize: 9,
          color: 'var(--text-faint)',
          textTransform: 'uppercase',
          letterSpacing: '0.22em',
        }}
      >
        Release history{rows.length > 0 ? ` · last ${rows.length}` : ''}
      </header>

      {rows.length === 0 ? (
        <div
          style={{
            padding: '20px 18px',
            color: 'var(--text-mute)',
            fontSize: 12,
            textAlign: 'center',
          }}
        >
          No deploys yet. History appears here once this plan ships at least once.
        </div>
      ) : (
        <ul style={{ listStyle: 'none', margin: 0, padding: 0 }}>
          {rows.map((r, i) => (
            <li
              key={r.jobId}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 14,
                padding: '10px 18px',
                borderTop: i === 0 ? 'none' : '1px solid var(--border)',
              }}
            >
              <StatusDot status={r.status} />
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 12, color: 'var(--foreground)' }}>
                  {formatAbsolute(r.startedAtIso)}
                </div>
                <div
                  style={{
                    fontFamily: 'var(--font-mono)',
                    fontSize: 10,
                    color: 'var(--text-mute)',
                    letterSpacing: '0.04em',
                    marginTop: 2,
                  }}
                >
                  {fmtDuration(r.durationSec)}
                  {r.sha ? ` · ${r.sha.slice(0, 7)}` : ''}
                </div>
              </div>
              {r.publicUrl && (
                <a
                  href={r.publicUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  style={{
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: 4,
                    fontSize: 10,
                    padding: '5px 9px',
                    border: '1px solid var(--border-2)',
                    borderRadius: 2,
                    color: 'var(--text-dim)',
                    textDecoration: 'none',
                    letterSpacing: '0.12em',
                    textTransform: 'uppercase',
                  }}
                >
                  Open
                  <ExternalLink size={9} aria-hidden="true" />
                </a>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function StatusDot({ status }: { status: DeployRecord['status'] }) {
  const succeeded = isTerminalDeploySuccess(status);
  const color = succeeded
    ? 'var(--success)'
    : status === 'FAILED'
      ? 'var(--destructive)'
      : 'var(--accent-purple)';
  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 5,
        fontFamily: 'var(--font-mono)',
        fontSize: 8,
        color,
        textTransform: 'uppercase',
        letterSpacing: '0.2em',
        padding: '3px 8px',
        borderRadius: 2,
        border: `1px solid ${color}`,
        background: `color-mix(in srgb, ${color} 10%, transparent)`,
        flexShrink: 0,
      }}
    >
      <span
        aria-hidden="true"
        style={{ background: color, width: 5, height: 5, borderRadius: '50%' }}
      />
      {succeeded ? 'live' : status.toLowerCase().replaceAll('_', ' ')}
    </span>
  );
}

function formatAbsolute(iso: string): string {
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return '—';
  return d.toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function fmtDuration(s: number | undefined): string {
  if (s == null || !Number.isFinite(s)) return '—';
  if (s < 60) return `${Math.round(s)}s`;
  const m = Math.floor(s / 60);
  const r = Math.round(s % 60);
  return `${m}m ${r}s`;
}
