'use client';

/**
 * Pillar card — one of AC / VQA / Gate. Takes a verdict + gauge + a preview
 * slot for the top 3 failing items (failures first). Clicking the header or
 * a preview row calls `onSelectFailure` which the parent routes to the
 * drill-down drawer (Wave 2). Wave 1 just renders placeholders for the
 * drawer hooks.
 */

import { ChevronRight } from 'lucide-react';
import type { QaPillarVerdict } from '@/types/qa-report';

interface Props {
  title: string;
  subtitle?: string;
  verdict: QaPillarVerdict;
  /** Numerator (pass) / denominator (total) for the big gauge line. */
  pass: number;
  total: number;
  /** Optional right-side value next to the gauge (e.g. "3 attention items"). */
  extraValue?: string;
  /** Optional right-side value color. */
  extraColor?: string;
  /** Rendered inside the card body — the preview content. */
  children?: React.ReactNode;
  /** Click handler on the "view all" anchor. */
  onViewAll?: () => void;
}

export function PillarCard({
  title,
  subtitle,
  verdict,
  pass,
  total,
  extraValue,
  extraColor,
  children,
  onViewAll,
}: Props) {
  const color = verdictColor(verdict);
  const isSkipped = verdict === 'skipped';
  const pct = total > 0 ? Math.round((pass / total) * 100) : 0;

  return (
    <div
      style={{
        background: 'var(--bg-elev)',
        border: '1px solid var(--border)',
        borderRadius: 8,
        padding: '18px 20px',
        display: 'flex',
        flexDirection: 'column',
        gap: 14,
        opacity: isSkipped ? 0.55 : 1,
      }}
    >
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12 }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div
            style={{
              fontFamily: 'var(--font-mono)',
              fontSize: 9,
              color: 'var(--text-faint)',
              textTransform: 'uppercase',
              letterSpacing: '0.22em',
              marginBottom: 6,
            }}
          >
            {title}
          </div>
          {subtitle && (
            <div
              style={{
                fontSize: 11,
                color: 'var(--text-mute)',
                lineHeight: 1.4,
                marginBottom: 2,
              }}
            >
              {subtitle}
            </div>
          )}
        </div>
        <VerdictDot verdict={verdict} />
      </div>

      {/* Gauge */}
      <div>
        <div
          style={{
            display: 'flex',
            alignItems: 'baseline',
            justifyContent: 'space-between',
            marginBottom: 6,
          }}
        >
          <span
            style={{
              fontFamily: 'var(--font-mono)',
              fontSize: 22,
              color,
              fontWeight: 300,
              letterSpacing: '-0.01em',
            }}
          >
            {isSkipped ? '—' : total === 0 ? '—' : `${pass}/${total}`}
          </span>
          {extraValue && (
            <span
              style={{
                fontFamily: 'var(--font-mono)',
                fontSize: 10,
                color: extraColor ?? 'var(--text-mute)',
                letterSpacing: '0.06em',
              }}
            >
              {extraValue}
            </span>
          )}
        </div>
        <div
          style={{
            height: 2,
            background: 'var(--border)',
            overflow: 'hidden',
          }}
        >
          <div
            style={{
              width: `${pct}%`,
              height: '100%',
              background: color,
              opacity: isSkipped ? 0.2 : 0.9,
              transition: 'width 300ms',
            }}
          />
        </div>
      </div>

      {/* Body */}
      {children && <div style={{ fontSize: 12 }}>{children}</div>}

      {/* View-all */}
      {onViewAll && !isSkipped && (
        <button
          type="button"
          onClick={onViewAll}
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 4,
            marginTop: 'auto',
            paddingTop: 6,
            fontSize: 10,
            letterSpacing: '0.14em',
            textTransform: 'uppercase',
            color: 'var(--text-dim)',
            background: 'transparent',
            border: 'none',
            cursor: 'pointer',
            alignSelf: 'flex-start',
          }}
        >
          View details
          <ChevronRight size={11} />
        </button>
      )}
    </div>
  );
}

// ── VerdictDot ───────────────────────────────────────────────────────

export function VerdictDot({ verdict }: { verdict: QaPillarVerdict }) {
  const color = verdictColor(verdict);
  const labels: Record<QaPillarVerdict, string> = {
    pass: 'pass',
    fail: 'fail',
    partial: 'partial',
    pending: 'pending',
    skipped: 'skipped',
  };
  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 6,
        fontFamily: 'var(--font-mono)',
        fontSize: 9,
        color,
        textTransform: 'uppercase',
        letterSpacing: '0.18em',
        flexShrink: 0,
      }}
    >
      <span
        style={{
          background: color,
          width: 6,
          height: 6,
          borderRadius: '50%',
          display: 'inline-block',
          opacity: verdict === 'skipped' ? 0.5 : 1,
        }}
      />
      {labels[verdict]}
    </span>
  );
}

function verdictColor(v: QaPillarVerdict): string {
  switch (v) {
    case 'pass':
      return 'var(--success)';
    case 'fail':
      return 'var(--destructive)';
    case 'partial':
      return 'var(--warning)';
    case 'skipped':
      return 'var(--text-faint)';
    case 'pending':
    default:
      return 'var(--text-mute)';
  }
}
