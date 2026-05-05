'use client';

/**
 * QA audit timeline — horizontal dot strip at the bottom of the QA page.
 *
 * Each dot is one historical QA run (oldest on the left). Color = verdict.
 * Tooltip shows ran-at + pass/fail counts. Click a dot to highlight the
 * run it represents (swapping to snapshot mode is Phase 2).
 *
 * The timeline also surfaces the "delta" pill between consecutive runs so
 * the operator can see "this run resolved 2 items, introduced 1 new."
 */

import type { QaReport, QaRunSummary } from '@/types/qa-report';

interface Props {
  report: QaReport;
}

export function AuditTimeline({ report }: Props) {
  const runs = report.runHistory;
  if (runs.length === 0) return null;

  const latest = runs[runs.length - 1];
  const previous = runs.length > 1 ? runs[runs.length - 2] : null;

  return (
    <div
      style={{
        border: '1px solid var(--border)',
        background: 'var(--bg-elev)',
        borderRadius: 8,
        padding: '14px 18px',
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 10,
          marginBottom: 14,
          flexWrap: 'wrap',
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
          QA run history
        </span>
        <span
          style={{
            fontFamily: 'var(--font-mono)',
            fontSize: 10,
            color: 'var(--text-mute)',
            letterSpacing: '0.06em',
          }}
        >
          {runs.length} run{runs.length === 1 ? '' : 's'} · last {relTime(latest.ranAt)}
        </span>
        {previous && <DeltaBadge previous={previous} current={latest} />}
      </div>

      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 2,
          overflowX: 'auto',
        }}
      >
        {runs.map((r, idx) => (
          <Dot key={r.runId} run={r} isLast={idx === runs.length - 1} />
        ))}
      </div>
    </div>
  );
}

function Dot({ run, isLast }: { run: QaRunSummary; isLast: boolean }) {
  const color = verdictColor(run.verdict);
  return (
    <div
      title={`${relTime(run.ranAt)} · ${run.vqaPass} pass / ${run.vqaFail} fail`}
      style={{
        display: 'flex',
        alignItems: 'center',
        flexShrink: 0,
      }}
    >
      <span
        style={{
          width: isLast ? 14 : 10,
          height: isLast ? 14 : 10,
          borderRadius: '50%',
          background: color,
          border: isLast ? '2px solid var(--foreground)' : '1px solid var(--border-2)',
          boxShadow: isLast ? `0 0 8px ${color}` : 'none',
          flexShrink: 0,
        }}
      />
      {/* Connector */}
      <span
        style={{
          width: 18,
          height: 1,
          background:
            'linear-gradient(90deg, var(--border-2), var(--border))',
          flexShrink: 0,
          marginLeft: 2,
          marginRight: 2,
        }}
      />
    </div>
  );
}

function DeltaBadge({ previous, current }: { previous: QaRunSummary; current: QaRunSummary }) {
  const resolved = Math.max(0, previous.vqaFail - current.vqaFail);
  const introduced = Math.max(0, current.vqaFail - previous.vqaFail);
  const stillFailing = current.vqaFail;
  if (resolved === 0 && introduced === 0 && stillFailing === 0) return null;
  return (
    <span
      style={{
        marginLeft: 'auto',
        fontFamily: 'var(--font-mono)',
        fontSize: 10,
        letterSpacing: '0.06em',
        display: 'inline-flex',
        gap: 10,
        alignItems: 'center',
      }}
    >
      {resolved > 0 && (
        <span style={{ color: 'var(--success)' }}>+{resolved} resolved</span>
      )}
      {introduced > 0 && (
        <span style={{ color: 'var(--destructive)' }}>+{introduced} new</span>
      )}
      {stillFailing > 0 && introduced === 0 && (
        <span style={{ color: 'var(--warning)' }}>
          {stillFailing} still failing
        </span>
      )}
    </span>
  );
}

function verdictColor(v: string): string {
  switch (v) {
    case 'ready':
      return 'var(--success)';
    case 'blocking':
      return 'var(--destructive)';
    case 'needs-attention':
      return 'var(--warning)';
    default:
      return 'var(--text-mute)';
  }
}

function relTime(iso: string): string {
  const ms = Date.now() - Date.parse(iso);
  if (!Number.isFinite(ms)) return '—';
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}
