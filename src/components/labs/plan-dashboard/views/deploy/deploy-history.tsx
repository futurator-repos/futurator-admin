'use client';

/**
 * Deploy history — stacked list of past deploys. Each row shows timestamp,
 * duration, outcome badge, URL (when recorded), and an "Open" affordance.
 * Deployment v2.5 — COMPLETED production releases are archived, so each can be
 * rolled back to (two-click armed confirm).
 */

import { useState } from 'react';
import { ExternalLink, Loader2, Undo2 } from 'lucide-react';
import type { DeployRecord } from '@/types/deploy-report';
import { useRollback } from '@/hooks/use-deploy-report';

export function DeployHistory({ history, planId }: { history: DeployRecord[]; planId: string }) {
  const rollback = useRollback(planId);

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
            <RollbackButton record={r} rollback={rollback} />
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * Rollback affordance — only for COMPLETED releases (those carry an archived
 * snapshot). Two-click armed confirm so a stray click can't revert production.
 */
function RollbackButton({
  record,
  rollback,
}: {
  record: DeployRecord;
  rollback: ReturnType<typeof useRollback>;
}) {
  const [armed, setArmed] = useState(false);
  const eligible = record.status === 'COMPLETED';
  const busy = rollback.isPending;

  if (!eligible) {
    return (
      <span
        title="Only successful production releases can be rolled back to"
        style={{
          fontSize: 10,
          padding: '6px 10px',
          color: 'var(--text-faint)',
          letterSpacing: '0.14em',
          textTransform: 'uppercase',
          opacity: 0.4,
        }}
      >
        Rollback
      </span>
    );
  }

  return (
    <button
      type="button"
      disabled={busy}
      onClick={() => {
        if (!armed) {
          setArmed(true);
          return;
        }
        rollback.mutate(record.jobId, { onSettled: () => setArmed(false) });
      }}
      onBlur={() => setArmed(false)}
      title={`Roll production back to release ${record.jobId.slice(0, 8)}`}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 6,
        fontSize: 10,
        padding: '6px 10px',
        border: `1px solid ${armed ? 'var(--destructive)' : 'var(--border-2)'}`,
        borderRadius: 2,
        color: armed ? 'var(--destructive)' : 'var(--text-dim)',
        background: armed
          ? 'color-mix(in srgb, var(--destructive) 10%, transparent)'
          : 'transparent',
        letterSpacing: '0.14em',
        textTransform: 'uppercase',
        cursor: busy ? 'not-allowed' : 'pointer',
        opacity: busy ? 0.6 : 1,
      }}
    >
      {busy ? <Loader2 size={10} className="animate-spin" /> : <Undo2 size={10} />}
      {armed ? 'Confirm?' : 'Rollback'}
    </button>
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
