'use client';

/**
 * Data Privacy Assessment dashboard (sibling to the hotspot dashboard). Renders
 * the capped/grouped PrivacyAuditSummary: per-regulation sections (GDPR, EU AI
 * Act) with severity count chips, category rollups, and expandable findings that
 * cite the primary law (clickable). Decision-support, not legal advice.
 */

import { useState } from 'react';
import type {
  PrivacyAuditSummary,
  PrivacyHotspot,
  PrivacyRegulationSlice,
} from '@/types/refactor-audit';

const SEVERITY_TONE: Record<string, string> = {
  critical: 'destructive',
  high: 'warning',
  medium: 'accent-blue',
  low: 'text-faint',
  info: 'text-faint',
};

const REG_LABEL: Record<string, string> = {
  gdpr: 'GDPR',
  'eu-ai-act': 'EU AI Act',
};

export function PrivacyDashboard({ privacy }: { privacy?: PrivacyAuditSummary }) {
  if (!privacy) {
    return (
      <div style={emptyStyle} data-testid="privacy-empty">
        No data privacy assessment for this run. Enable “Include data privacy” and re-assess.
      </div>
    );
  }
  if (privacy.failed) {
    return (
      <div
        style={{
          ...emptyStyle,
          color: 'var(--destructive)',
          borderColor: 'color-mix(in srgb, var(--destructive) 30%, transparent)',
        }}
        data-testid="privacy-failed"
      >
        Data privacy assessment failed [{privacy.reason || 'error'}]: {privacy.error || ''}
      </div>
    );
  }

  const regs = privacy.regulations ?? Object.keys(privacy.byRegulation ?? {});

  return (
    <div
      data-testid="privacy-dashboard"
      style={{ display: 'flex', flexDirection: 'column', gap: 16 }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 10,
          flexWrap: 'wrap',
          fontSize: 11,
          color: 'var(--text-dim)',
        }}
      >
        <span style={{ fontWeight: 600, color: 'var(--foreground)' }}>
          {privacy.totalDetected ?? 0} privacy findings
        </span>
        <span>· tier {privacy.tier ?? '?'}</span>
        {privacy.cardsLoaded != null && <span>· {privacy.cardsLoaded} rule cards</span>}
        <span style={{ color: 'var(--text-faint)' }}>· decision-support, not legal advice</span>
      </div>

      {regs.map((reg) => {
        const slice = privacy.byRegulation?.[reg];
        if (!slice) return null;
        return <RegulationSection key={reg} reg={reg} slice={slice} />;
      })}
    </div>
  );
}

function RegulationSection({ reg, slice }: { reg: string; slice: PrivacyRegulationSlice }) {
  const sev = slice.summary || {};
  const topCategories = Object.entries(slice.byCategory || {})
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8);
  return (
    <div data-testid={`privacy-reg-${reg}`}>
      <div
        style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6, flexWrap: 'wrap' }}
      >
        <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--foreground)' }}>
          {REG_LABEL[reg] || reg}
        </span>
        <span style={{ fontSize: 11, color: 'var(--text-faint)' }}>
          {slice.detectedCount} findings · {slice.scannedFiles} files scanned
          {slice.shownCount < slice.detectedCount ? ` · top ${slice.shownCount} shown` : ''}
        </span>
        <div style={{ flex: 1 }} />
        {(['critical', 'high', 'medium', 'low'] as const)
          .filter((s) => (sev[s] ?? 0) > 0)
          .map((s) => (
            <SevChip key={s} sev={s} n={sev[s] ?? 0} />
          ))}
      </div>

      {topCategories.length > 0 && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginBottom: 8 }}>
          {topCategories.map(([cat, n]) => (
            <span key={cat} style={catChipStyle} title={`${n} findings`}>
              {cat} · {n}
            </span>
          ))}
        </div>
      )}

      <div
        style={{
          border: '1px solid var(--border)',
          borderRadius: 10,
          background: 'var(--bg-elev)',
          overflow: 'hidden',
        }}
      >
        {slice.hotspots.map((h, i) => (
          <PrivacyRow key={`${reg}-${i}`} h={h} />
        ))}
      </div>
    </div>
  );
}

function PrivacyRow({ h }: { h: PrivacyHotspot }) {
  const [open, setOpen] = useState(false);
  return (
    <div
      data-testid="privacy-finding"
      data-severity={h.severity}
      style={{ borderBottom: '1px solid var(--border)' }}
    >
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        style={{
          width: '100%',
          display: 'flex',
          alignItems: 'center',
          gap: 10,
          padding: '8px 14px',
          background: 'transparent',
          border: 'none',
          cursor: 'pointer',
          textAlign: 'left',
        }}
      >
        <SevChip sev={h.severity} />
        <span
          style={{
            fontFamily: 'var(--font-mono)',
            fontSize: 10,
            color: 'var(--text-faint)',
            minWidth: 28,
          }}
        >
          {Math.round(h.score)}
        </span>
        <span
          style={{
            fontSize: 12,
            color: 'var(--foreground)',
            flex: '1 1 auto',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
        >
          {h.category}
          <span style={{ color: 'var(--text-faint)' }}> — {h.regulation}</span>
        </span>
        <span style={{ color: 'var(--text-faint)', fontSize: 10 }}>{open ? '▼' : '▶'}</span>
      </button>
      {open && (
        <div
          style={{
            padding: '0 14px 12px 40px',
            fontSize: 11,
            color: 'var(--text-dim)',
            display: 'flex',
            flexDirection: 'column',
            gap: 6,
          }}
        >
          <div style={{ color: 'var(--foreground)' }}>{h.title}</div>
          <div>
            <span style={metaLabel}>file</span> <code style={codeChip}>{h.file}</code>
          </div>
          {h.snippet && (
            <div>
              <span style={metaLabel}>signals</span>{' '}
              <span style={{ fontFamily: 'var(--font-mono)', fontSize: 10 }}>{h.snippet}</span>
            </div>
          )}
          {h.remediation && (
            <div>
              <span style={metaLabel}>remediation</span> {h.remediation}
              {h.solution_ceiling ? ` (${h.solution_ceiling})` : ''}
            </div>
          )}
          {Array.isArray(h.citation) && h.citation.length > 0 && (
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'center' }}>
              <span style={metaLabel}>citation</span>
              {[...new Set(h.citation)].map((url) => (
                <a
                  key={url}
                  href={url}
                  target="_blank"
                  rel="noopener noreferrer"
                  style={{ fontSize: 10, color: 'var(--accent-blue)' }}
                >
                  {prettyUrl(url)} ↗
                </a>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function SevChip({ sev, n }: { sev: string; n?: number }) {
  const tone = SEVERITY_TONE[sev] || 'text-faint';
  return (
    <span
      style={{
        fontFamily: 'var(--font-mono)',
        fontSize: 9,
        fontWeight: 600,
        textTransform: 'uppercase',
        letterSpacing: '0.06em',
        color: `var(--${tone})`,
        border: `1px solid color-mix(in srgb, var(--${tone}) 40%, transparent)`,
        background: `color-mix(in srgb, var(--${tone}) 9%, transparent)`,
        borderRadius: 3,
        padding: '1px 5px',
        whiteSpace: 'nowrap',
        flex: '0 0 auto',
      }}
    >
      {n != null ? `${n} ` : ''}
      {sev}
    </span>
  );
}

function prettyUrl(u: string): string {
  try {
    const url = new URL(u);
    return url.hostname.replace(/^www\./, '') + url.pathname.replace(/\/$/, '').slice(0, 24);
  } catch {
    return u.slice(0, 30);
  }
}

const emptyStyle: React.CSSProperties = {
  padding: 14,
  fontSize: 12,
  color: 'var(--text-dim)',
  border: '1px dashed var(--border)',
  borderRadius: 10,
};
const metaLabel: React.CSSProperties = {
  fontFamily: 'var(--font-mono)',
  fontSize: 9,
  textTransform: 'uppercase',
  letterSpacing: '0.12em',
  color: 'var(--text-faint)',
};
const codeChip: React.CSSProperties = {
  fontFamily: 'var(--font-mono)',
  fontSize: 10,
  color: 'var(--text-dim)',
  background: 'color-mix(in srgb, var(--foreground) 5%, transparent)',
  padding: '1px 5px',
  borderRadius: 3,
};
const catChipStyle: React.CSSProperties = {
  fontSize: 10,
  color: 'var(--text-dim)',
  border: '1px solid var(--border)',
  borderRadius: 10,
  padding: '1px 8px',
};
