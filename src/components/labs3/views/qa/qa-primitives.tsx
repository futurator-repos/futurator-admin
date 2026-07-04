'use client';

/**
 * QA primitives (QA-Review W2) — Field / Banner / StatusChip / EvidenceImage.
 *
 * COPIED (not imported — Labs3 keeps a clean sibling boundary, see
 * adapter.ts:23-24) from the legacy claims table
 * (src/components/labs/plan-dashboard/views/qa/claims-table.tsx):
 *   - Field    (L693-711)
 *   - Banner   (L713-729)
 *   - StatusChip (L811-832) — re-typed against the P3-native LaneVerdict
 *     ('pass' | 'fail' | 'uncertain') instead of the legacy VqaTestStatus,
 *     since W2 has no 'pending' / 'skipped-budget' / 'errored' states.
 *   - The broken-image onError guard (L287-330 thumbnail form, L400-411
 *     full-size form) — generalized here as <EvidenceImage>.
 *
 * Presentational only. Shared by the other new QA-Review W2 panels
 * (journeys, before/after VQA, wiring) so they stay visually consistent
 * with the rest of Labs3 without reaching across the module boundary.
 */

import { useState } from 'react';
import { ImageOff } from 'lucide-react';
import type { LaneVerdict } from '@/types/qa-review-p3';

// ── Field — labeled block ────────────────────────────────────────────

export function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <div
        style={{
          fontFamily: 'var(--font-mono)',
          fontSize: 8.5,
          color: 'var(--text-faint)',
          textTransform: 'uppercase',
          letterSpacing: '0.2em',
          marginBottom: 5,
        }}
      >
        {label}
      </div>
      {children}
    </div>
  );
}

// ── Banner — colored callout ─────────────────────────────────────────

export function Banner({ color, children }: { color: string; children: React.ReactNode }) {
  return (
    <div
      style={{
        padding: '8px 11px',
        borderRadius: 5,
        fontSize: 12,
        lineHeight: 1.45,
        background: `color-mix(in srgb, ${color} 9%, transparent)`,
        border: `1px solid color-mix(in srgb, ${color} 50%, transparent)`,
        color: 'var(--text-dim)',
      }}
    >
      {children}
    </div>
  );
}

// ── StatusChip — LaneVerdict (pass | fail | uncertain) ───────────────

const STATUS_META: Record<LaneVerdict, { label: string; color: string }> = {
  pass: { label: 'pass', color: 'var(--success)' },
  fail: { label: 'fail', color: 'var(--destructive)' },
  uncertain: { label: 'uncertain', color: 'var(--warning)' },
};

export function StatusChip({ status }: { status: LaneVerdict }) {
  const meta = STATUS_META[status] ?? { label: status, color: 'var(--text-mute)' };
  return (
    <span
      style={{
        fontFamily: 'var(--font-mono)',
        fontSize: 9.5,
        fontWeight: 700,
        letterSpacing: '0.1em',
        textTransform: 'uppercase',
        color: meta.color,
        border: `1px solid color-mix(in srgb, ${meta.color} 50%, transparent)`,
        background: `color-mix(in srgb, ${meta.color} 8%, transparent)`,
        borderRadius: 3,
        padding: '2px 8px',
        whiteSpace: 'nowrap',
      }}
    >
      {meta.label}
    </span>
  );
}

// ── EvidenceImage — broken-image (404 / capture-upload-failure) guard ─
//
// A screenshot URL that fails to load is broken EVIDENCE (an infra
// capture/upload failure), not "no screenshot" — surface it instead of
// silently hiding it, so the operator sees the integrity gap.

export function EvidenceImage({
  src,
  alt,
  width = 56,
  height = 36,
  borderColor,
}: {
  src?: string;
  alt: string;
  width?: number | string;
  height?: number | string;
  /** Border color for the loaded image (e.g. pass/fail tint). Defaults to var(--border-2). */
  borderColor?: string;
}) {
  const [broken, setBroken] = useState(false);

  if (!src) {
    return (
      <span style={{ fontFamily: 'var(--font-mono)', fontSize: 9, color: 'var(--text-faint)' }}>
        —
      </span>
    );
  }

  if (broken) {
    return (
      <span
        title="Screenshot evidence missing or broken (capture/upload failure)"
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: 4,
          fontFamily: 'var(--font-mono)',
          fontSize: 9,
          color: 'var(--warning, #b45309)',
          border: '1px dashed var(--warning, #b45309)',
          borderRadius: 4,
          padding: '4px 6px',
          whiteSpace: 'nowrap',
        }}
      >
        <ImageOff size={11} aria-hidden />
        evidence broken
      </span>
    );
  }

  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={src}
      alt={alt}
      style={{
        width,
        height,
        objectFit: 'cover',
        borderRadius: 4,
        border: `1px solid ${borderColor ?? 'var(--border-2)'}`,
        display: 'inline-block',
        verticalAlign: 'middle',
      }}
      onError={() => setBroken(true)}
    />
  );
}
