'use client';

/**
 * Plan Retrospect — the Reality Check card for ONE stage (spec §3 / §7.2).
 *
 * Renders a stage's graded slices: 🟢🟡🔴⚪ per criterion, each row expandable
 * to (a) the evidence ref/anchor and (b) the matched F-finding chips with their
 * per-finding shipped/open state. Quantitative criteria carry a
 * "v0 threshold (unvalidated)" caveat badge; ⚪ rows surface their
 * "needs-instrumentation" note. The card NEVER invents or omits a mapped
 * finding — it renders exactly what the slice carries.
 */

import { useState } from 'react';
import type { ScorecardSlice, FixRef, Verdict } from '@/types/scorecard';

const VERDICT_TONE: Record<Verdict, string> = {
  '🟢': 'success',
  '🟡': 'warning',
  '🔴': 'destructive',
  '⚪': 'text-faint',
};

/** A criterion whose value is a measured number gets the v0-threshold caveat. */
function isQuantitative(slice: ScorecardSlice): boolean {
  return typeof slice.value === 'number';
}

export function RealityCheckCard({
  stageLabel,
  slices,
}: {
  stageLabel: string;
  slices: ScorecardSlice[];
}) {
  if (slices.length === 0) {
    return (
      <div
        style={{
          padding: 14,
          fontSize: 12,
          color: 'var(--text-dim)',
          border: '1px dashed var(--border)',
          borderRadius: 10,
        }}
      >
        No verdict yet for {stageLabel}. Run analysis to grade this stage.
      </div>
    );
  }

  const reds = slices.filter((s) => s.verdict === '🔴').length;
  const ambers = slices.filter((s) => s.verdict === '🟡').length;
  const greys = slices.filter((s) => s.verdict === '⚪').length;

  return (
    <div
      data-testid={`reality-check-card`}
      style={{
        border: '1px solid var(--border)',
        borderRadius: 10,
        background: 'var(--bg-elev)',
        overflow: 'hidden',
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          padding: '10px 14px',
          borderBottom: '1px solid var(--border)',
        }}
      >
        <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--foreground)' }}>
          {stageLabel}
        </span>
        <div style={{ flex: 1 }} />
        {reds > 0 && <CountChip n={reds} tone="destructive" label="red" />}
        {ambers > 0 && <CountChip n={ambers} tone="warning" label="amber" />}
        {greys > 0 && <CountChip n={greys} tone="text-faint" label="needs instr." />}
      </div>
      <div>
        {slices.map((s) => (
          <CriterionRow key={s.criterionId} slice={s} />
        ))}
      </div>
    </div>
  );
}

function CriterionRow({ slice }: { slice: ScorecardSlice }) {
  const [open, setOpen] = useState(false);
  const tone = VERDICT_TONE[slice.verdict];
  const quantitative = isQuantitative(slice);

  return (
    <div
      data-testid={`criterion-${slice.criterionId}`}
      data-verdict={slice.verdict}
      style={{ borderBottom: '1px solid var(--border)' }}
    >
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
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
        <span style={{ fontSize: 13, flex: '0 0 auto' }}>{slice.verdict}</span>
        <span
          style={{
            fontFamily: 'var(--font-mono)',
            fontSize: 11,
            fontWeight: 600,
            color: 'var(--foreground)',
            flex: '0 0 auto',
            minWidth: 56,
          }}
        >
          {slice.criterionId}
        </span>
        <span
          style={{
            fontFamily: 'var(--font-mono)',
            fontSize: 11,
            color: `var(--${tone})`,
            flex: '0 1 auto',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
        >
          {String(slice.value)}
        </span>
        {slice.confidence === 'unreconciled' && (
          <MiniBadge tone="warning" label="lower bound · unreconciled" />
        )}
        {quantitative && <MiniBadge tone="text-faint" label="v0 threshold (unvalidated)" />}
        {slice.engine === 'assessor' && <MiniBadge tone="accent-blue" label="Assessor" />}
        <div style={{ flex: 1 }} />
        {slice.fixIds.map((f) => (
          <FixChip key={`${slice.criterionId}-${f.id}`} fix={f} />
        ))}
        <span style={{ color: 'var(--text-faint)', fontSize: 10, marginLeft: 4 }}>
          {open ? '▼' : '▶'}
        </span>
      </button>

      {open && (
        <div style={{ padding: '0 14px 12px 40px', fontSize: 11, color: 'var(--text-dim)' }}>
          {/* needs-instrumentation note for ⚪ rows (honesty surface). */}
          {slice.verdict === '⚪' && slice.note && (
            <div
              style={{
                color: 'var(--text-faint)',
                fontStyle: 'italic',
                marginBottom: 8,
                fontFamily: 'var(--font-mono)',
                fontSize: 10,
              }}
            >
              {slice.note}
            </div>
          )}
          {slice.verdict !== '⚪' && slice.note && (
            <div style={{ marginBottom: 8 }}>{slice.note}</div>
          )}

          {/* Evidence ref/anchor — NOT a dump (spec §5). */}
          <div style={{ marginBottom: slice.ieIds.length > 0 ? 8 : 0 }}>
            <span
              style={{
                fontFamily: 'var(--font-mono)',
                fontSize: 9,
                textTransform: 'uppercase',
                letterSpacing: '0.12em',
                color: 'var(--text-faint)',
                marginRight: 6,
              }}
            >
              {slice.evidence.kind}
            </span>
            <code
              style={{
                fontFamily: 'var(--font-mono)',
                fontSize: 10,
                color: 'var(--text-dim)',
                background: 'color-mix(in srgb, var(--foreground) 5%, transparent)',
                padding: '1px 5px',
                borderRadius: 3,
              }}
            >
              {slice.evidence.ref}
            </code>
          </div>

          {/* Reproduced anti-patterns (IE ids). */}
          {slice.ieIds.length > 0 && (
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, alignItems: 'center' }}>
              <span style={{ fontSize: 10, color: 'var(--text-faint)' }}>reproduces</span>
              {slice.ieIds.map((ie) => (
                <span
                  key={ie}
                  style={{
                    fontFamily: 'var(--font-mono)',
                    fontSize: 9,
                    fontWeight: 600,
                    color: 'var(--destructive)',
                    border: '1px solid color-mix(in srgb, var(--destructive) 40%, transparent)',
                    borderRadius: 3,
                    padding: '1px 5px',
                  }}
                >
                  {ie}
                </span>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/** A matched F-finding / story chip with per-finding shipped/open state. */
function FixChip({ fix }: { fix: FixRef }) {
  const shipped = fix.status === 'shipped' || fix.status === 'verified';
  const tone = shipped ? 'success' : 'destructive';
  const label = fix.kind === 'story' ? `Story ${fix.id}` : fix.id;
  const title = shipped
    ? `${label} — ${fix.status}${fix.sha ? ` (${fix.sha})` : ''} · verify it held`
    : `${label} — open${fix.dependsOn?.length ? ` · needs ${fix.dependsOn.join(', ')}` : ''}`;
  return (
    <span
      title={title}
      style={{
        fontFamily: 'var(--font-mono)',
        fontSize: 9,
        fontWeight: 600,
        color: `var(--${tone})`,
        border: `1px solid color-mix(in srgb, var(--${tone}) 45%, transparent)`,
        background: `color-mix(in srgb, var(--${tone}) 9%, transparent)`,
        borderRadius: 3,
        padding: '1px 5px',
        whiteSpace: 'nowrap',
        flex: '0 0 auto',
      }}
    >
      {label}
      {shipped ? (fix.sha ? ` ✓ ${fix.sha}` : ' ✓') : ' ·open'}
    </span>
  );
}

function MiniBadge({ tone, label }: { tone: string; label: string }) {
  return (
    <span
      style={{
        fontFamily: 'var(--font-mono)',
        fontSize: 8,
        fontWeight: 600,
        textTransform: 'uppercase',
        letterSpacing: '0.06em',
        color: `var(--${tone})`,
        border: `1px solid color-mix(in srgb, var(--${tone}) 35%, transparent)`,
        borderRadius: 3,
        padding: '1px 4px',
        whiteSpace: 'nowrap',
        flex: '0 0 auto',
      }}
    >
      {label}
    </span>
  );
}

function CountChip({ n, tone, label }: { n: number; tone: string; label: string }) {
  return (
    <span
      style={{
        fontFamily: 'var(--font-mono)',
        fontSize: 10,
        fontWeight: 600,
        color: `var(--${tone})`,
        whiteSpace: 'nowrap',
      }}
    >
      {n} {label}
    </span>
  );
}
