'use client';

/**
 * Deploy history — stacked list of past deploys. Each row shows timestamp,
 * duration, outcome badge, URL (when recorded), and an "Open" affordance.
 * Rollback action is deferred (see deferred-features card); shown as
 * disabled with tooltip for now.
 */

import { ExternalLink } from 'lucide-react';
import type { DeployRecord } from '@/types/deploy-report';

export function DeployHistory({ history }: { history: DeployRecord[] }) {
  if (history.length === 0) {
    return (
      <div
        style={{
          padding: '24px 18px',
          border: '1px dashed var(--border-2)',
          background: 'var(--bg-elev)',
          borderRadius: 8,
          color: 'var(--text-mute)',
          fontSize: 12,
          textAlign: 'center',
        }}
      >
        No prior deploys. History appears here once you&apos;ve shipped at least twice.
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
          fontFamily: 'var(--font-mono)',
          fontSize: 9,
          color: 'var(--text-faint)',
          textTransform: 'uppercase',
          letterSpacing: '0.22em',
        }}
      >
        Deploy history · {history.length} past deploy{history.length === 1 ? '' : 's'}
      </div>
      <ul style={{ listStyle: 'none', margin: 0, padding: 0 }}>
        {history.map((r, i) => (
          <li
            key={r.jobId}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 14,
              padding: '12px 18px',
              borderTop: i === 0 ? 'none' : '1px solid var(--border)',
            }}
          >
            <StatusBadge status={r.status} />
            <div style={{ flex: 1, minWidth: 0 }}>
              <div
                style={{
                  fontSize: 12,
                  color: 'var(--foreground)',
                  letterSpacing: '-0.002em',
                }}
              >
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
                {fmtDuration(r.durationSec)} · job {r.jobId.slice(0, 8)}
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
                  padding: '6px 10px',
                  border: '1px solid var(--border-2)',
                  borderRadius: 2,
                  color: 'var(--text-dim)',
                  textDecoration: 'none',
                  letterSpacing: '0.14em',
                  textTransform: 'uppercase',
                }}
              >
                Open
                <ExternalLink size={10} />
              </a>
            )}
            <button
              type="button"
              disabled
              title="Rollback is planned for v2 — see Deferred Features"
              style={{
                fontSize: 10,
                padding: '6px 10px',
                border: '1px solid var(--border)',
                borderRadius: 2,
                color: 'var(--text-faint)',
                background: 'transparent',
                letterSpacing: '0.14em',
                textTransform: 'uppercase',
                cursor: 'not-allowed',
                opacity: 0.5,
              }}
            >
              Rollback
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

function StatusBadge({ status }: { status: DeployRecord['status'] }) {
  const color =
    status === 'COMPLETED'
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
        letterSpacing: '0.22em',
        padding: '3px 8px',
        borderRadius: 2,
        border: `1px solid ${color}`,
        background: `color-mix(in srgb, ${color} 10%, transparent)`,
        flexShrink: 0,
      }}
    >
      <span
        style={{
          background: color,
          width: 5,
          height: 5,
          borderRadius: '50%',
          display: 'inline-block',
        }}
      />
      {status === 'COMPLETED' ? 'live' : status.toLowerCase()}
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
