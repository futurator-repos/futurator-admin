'use client';

/**
 * Refactoring Assessment Module — severity-ranked hotspot dashboard (Epic D2,
 * FR32/FR33/NFR16/NFR18).
 *
 * Renders the recon `hotspots.json` (AuditHotspot[]): per-kind count chips in a
 * header + expandable hotspot rows grouped by workstream (design-system /
 * god-objects / legacy / dead-code), ranked severity-descending. Severity pairs
 * a color chip with a TEXT label (never color alone, NFR16). Evidence is a
 * reference — file:line / counts — never a code dump (FR33). Reuses the
 * reality-check-card inline-style + CSS-var dialect.
 */

import { useState } from 'react';
import type { AuditHotspot, HotspotSeverity, HotspotWorkstream } from '@/types/refactor-audit';
import { WORKSTREAM_OF } from '@/types/refactor-audit';

/** Severity → semantic CSS token (paired with a text label, never color alone). */
const SEVERITY_TONE: Record<HotspotSeverity, string> = {
  critical: 'destructive',
  high: 'warning',
  medium: 'accent-blue',
  low: 'text-faint',
};

const WORKSTREAM_LABEL: Record<HotspotWorkstream, string> = {
  'design-system': 'Design System',
  'god-objects': 'God Objects',
  legacy: 'Legacy / Duplication',
  'dead-code': 'Dead Code',
};

/** Workstream render order — highest-impact first. */
const WORKSTREAM_ORDER: HotspotWorkstream[] = [
  'design-system',
  'god-objects',
  'legacy',
  'dead-code',
];

export function HotspotDashboard({
  hotspots,
  onCreatePlan,
}: {
  hotspots: AuditHotspot[];
  /** Create-plan seam (D3) — called with the hotspot(s) to compile into a plan. */
  onCreatePlan?: (hotspots: AuditHotspot[]) => void;
}) {
  if (hotspots.length === 0) {
    return (
      <div
        style={{
          padding: 14,
          fontSize: 12,
          color: 'var(--text-dim)',
          border: '1px dashed var(--border)',
          borderRadius: 10,
        }}
        data-testid="hotspot-dashboard-empty"
      >
        No hotspots found. The recon ran clean, or this app is small enough that no refactor targets
        crossed the detection thresholds.
      </div>
    );
  }

  // Group by workstream, preserving the severity-descending order within each.
  const byWorkstream = new Map<HotspotWorkstream, AuditHotspot[]>();
  for (const h of hotspots) {
    const ws = WORKSTREAM_OF[h.kind];
    if (!byWorkstream.has(ws)) byWorkstream.set(ws, []);
    byWorkstream.get(ws)!.push(h);
  }

  // Header severity tally (across all hotspots).
  const tally: Record<HotspotSeverity, number> = { critical: 0, high: 0, medium: 0, low: 0 };
  for (const h of hotspots) tally[h.severity]++;

  return (
    <div
      data-testid="hotspot-dashboard"
      style={{ display: 'flex', flexDirection: 'column', gap: 16 }}
    >
      {/* Header — count chips by severity (color + label). */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
        <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--foreground)' }}>
          {hotspots.length} hotspot{hotspots.length === 1 ? '' : 's'}
        </span>
        <div style={{ flex: 1 }} />
        {(['critical', 'high', 'medium', 'low'] as HotspotSeverity[])
          .filter((s) => tally[s] > 0)
          .map((s) => (
            <SeverityChip key={s} severity={s} count={tally[s]} />
          ))}
      </div>

      {/* One group per workstream, in impact order. */}
      {WORKSTREAM_ORDER.filter((ws) => byWorkstream.has(ws)).map((ws) => {
        const rows = byWorkstream.get(ws)!;
        return (
          <div key={ws} data-testid={`workstream-${ws}`}>
            <div
              style={{
                fontSize: 11,
                fontWeight: 600,
                textTransform: 'uppercase',
                letterSpacing: '0.08em',
                color: 'var(--text-dim)',
                marginBottom: 6,
                display: 'flex',
                alignItems: 'center',
                gap: 8,
              }}
            >
              {WORKSTREAM_LABEL[ws]}
              <span style={{ color: 'var(--text-faint)', fontWeight: 400 }}>· {rows.length}</span>
            </div>
            <div
              style={{
                border: '1px solid var(--border)',
                borderRadius: 10,
                background: 'var(--bg-elev)',
                overflow: 'hidden',
              }}
            >
              {rows.map((h, i) => (
                <HotspotRow key={`${h.kind}-${i}`} hotspot={h} onCreatePlan={onCreatePlan} />
              ))}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function HotspotRow({
  hotspot,
  onCreatePlan,
}: {
  hotspot: AuditHotspot;
  onCreatePlan?: (hotspots: AuditHotspot[]) => void;
}) {
  const [open, setOpen] = useState(false);

  return (
    <div
      data-testid={`hotspot-${hotspot.kind}`}
      data-severity={hotspot.severity}
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
        <SeverityChip severity={hotspot.severity} />
        <span
          style={{
            fontFamily: 'var(--font-mono)',
            fontSize: 10,
            color: 'var(--text-faint)',
            flex: '0 0 auto',
            minWidth: 28,
          }}
          title="fused score 0–100"
        >
          {Math.round(hotspot.score)}
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
          {hotspot.title}
        </span>
        <span style={{ color: 'var(--text-faint)', fontSize: 10, marginLeft: 4 }}>
          {open ? '▼' : '▶'}
        </span>
      </button>

      {open && (
        <div style={{ padding: '0 14px 12px 40px', fontSize: 11, color: 'var(--text-dim)' }}>
          {/* Suggested action — the extract→repoint→delete sketch. */}
          <div style={{ marginBottom: 10 }}>{hotspot.suggestedAction}</div>

          {/* Implicated files — references, never a dump (FR33). */}
          {hotspot.files.length > 0 && (
            <div style={{ marginBottom: 8 }}>
              <span style={metaLabelStyle}>files ({hotspot.files.length})</span>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginTop: 4 }}>
                {hotspot.files.slice(0, 12).map((f) => (
                  <code key={f} style={fileChipStyle}>
                    {f}
                  </code>
                ))}
                {hotspot.files.length > 12 && (
                  <span style={{ fontSize: 10, color: 'var(--text-faint)' }}>
                    +{hotspot.files.length - 12} more
                  </span>
                )}
              </div>
            </div>
          )}

          {/* Evidence — structured pointer, kind-specific. */}
          <EvidenceLine hotspot={hotspot} />

          {onCreatePlan && (
            <button
              type="button"
              onClick={() => onCreatePlan([hotspot])}
              data-testid="hotspot-create-plan"
              style={createPlanBtnStyle}
            >
              Create plan from this hotspot →
            </button>
          )}
        </div>
      )}
    </div>
  );
}

function EvidenceLine({ hotspot }: { hotspot: AuditHotspot }) {
  const e = hotspot.evidence;
  const bits: string[] = [];
  if (e.methods != null) bits.push(`${e.methods} methods`);
  if (e.importers != null) bits.push(`${e.importers} importers`);
  if (e.community != null) bits.push(`community ${e.community}`);
  if (e.copies?.length) bits.push(`${e.copies.length} copies`);
  if (e.count != null) bits.push(`${e.count} files`);
  if (e.canonical) bits.push(`canonical ${e.canonical}`);
  if (e.duplicatedComponents?.length) bits.push(`${e.duplicatedComponents.length} dup components`);
  if (e.size != null) bits.push(`${e.size} nodes`);
  if (e.cohesion != null) bits.push(`cohesion ${e.cohesion}`);
  if (e.knipFlagged != null) bits.push(`${e.knipFlagged} knip-flagged`);
  if (e.confirmedZeroFanIn != null) bits.push(`${e.confirmedZeroFanIn} zero-fan-in`);
  if (bits.length === 0) return null;
  return (
    <div>
      <span style={metaLabelStyle}>evidence</span>
      <code style={{ ...fileChipStyle, marginLeft: 6 }}>{bits.join(' · ')}</code>
    </div>
  );
}

/** Severity chip — color token + always a text label (NFR16). */
function SeverityChip({ severity, count }: { severity: HotspotSeverity; count?: number }) {
  const tone = SEVERITY_TONE[severity];
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
      {count != null ? `${count} ` : ''}
      {severity}
    </span>
  );
}

const metaLabelStyle: React.CSSProperties = {
  fontFamily: 'var(--font-mono)',
  fontSize: 9,
  textTransform: 'uppercase',
  letterSpacing: '0.12em',
  color: 'var(--text-faint)',
};

const fileChipStyle: React.CSSProperties = {
  fontFamily: 'var(--font-mono)',
  fontSize: 10,
  color: 'var(--text-dim)',
  background: 'color-mix(in srgb, var(--foreground) 5%, transparent)',
  padding: '1px 5px',
  borderRadius: 3,
};

const createPlanBtnStyle: React.CSSProperties = {
  marginTop: 12,
  fontSize: 11,
  fontWeight: 600,
  color: 'var(--accent-blue)',
  background: 'transparent',
  border: '1px solid color-mix(in srgb, var(--accent-blue) 40%, transparent)',
  borderRadius: 6,
  padding: '5px 10px',
  cursor: 'pointer',
};
