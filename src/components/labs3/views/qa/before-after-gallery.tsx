'use client';

/**
 * BeforeAfterGallery — QA-Review W2, Lane 2 (VQA judge).
 *
 * Renders every journey step carrying a `vqa` payload as a before/after
 * screenshot PAIR — never a single frame — beside the VLM verdict pill, the
 * judge's rationale, and a ref to the source diff the judge was given. This
 * is the surface that makes pacman3-class regressions (a colored-squares
 * placeholder, a stub renderer masquerading as the real UI) visible: a
 * `fail` verdict gets a destructive border + the rationale text rendered in
 * full, not just a red dot.
 *
 * A screenshot that fails to load (404 / capture-upload failure) is broken
 * EVIDENCE, not "no screenshot" — surfaced via the shared EvidenceImage
 * onError guard (COPIED into qa-primitives.tsx from the legacy claims-table
 * broken-image guard; reused here rather than re-copied, see
 * qa-primitives.tsx:1-20).
 *
 * Presentational only — no data fetching. Input is JourneyResult[] (not the
 * flattened P3QaReport.vqa[]) because only the per-step StepVqa carries
 * `sourceDiffRef`, which this contract requires.
 */

import { ExternalLink } from 'lucide-react';
import { EvidenceImage, Field, StatusChip } from './qa-primitives';
import type { JourneyResult, LaneVerdict } from '@/types/qa-review-p3';

export interface BeforeAfterGalleryProps {
  journeys: JourneyResult[];
}

// ── Pure helpers (exported + unit-tested) ────────────────────────────

/** One flattened journey-step VQA entry, ready to render. */
export interface VqaStepEntry {
  journeyId: string;
  journeyTitle: string;
  stepLabel: string;
  key: string;
  verdict: LaneVerdict;
  rationale: string;
  beforeShotUrl: string;
  afterShotUrl: string;
  sourceDiffRef: string;
}

/** Flatten journeys → steps that carry a vqa payload, in stable order. */
export function collectVqaSteps(journeys: JourneyResult[]): VqaStepEntry[] {
  const entries: VqaStepEntry[] = [];
  for (const journey of journeys) {
    for (const step of journey.steps) {
      if (!step.vqa) continue;
      entries.push({
        journeyId: journey.id,
        journeyTitle: journey.title,
        stepLabel: step.label,
        key: `${journey.id}:${step.label}`,
        verdict: step.vqa.verdict,
        rationale: step.vqa.rationale,
        beforeShotUrl: step.vqa.beforeShotUrl,
        afterShotUrl: step.vqa.afterShotUrl,
        sourceDiffRef: step.vqa.sourceDiffRef,
      });
    }
  }
  return entries;
}

/** Card accent color for a step, keyed by its LaneVerdict. */
export function verdictBorderColor(verdict: LaneVerdict): string {
  switch (verdict) {
    case 'fail':
      return 'var(--destructive)';
    case 'uncertain':
      return 'var(--warning)';
    case 'pass':
    default:
      return 'var(--success)';
  }
}

/** True if a sourceDiffRef looks like an openable URL rather than a bare path/key. */
export function isDiffRefUrl(ref: string): boolean {
  return /^https?:\/\//i.test(ref);
}

// ── Component ─────────────────────────────────────────────────────────

export function BeforeAfterGallery({ journeys }: BeforeAfterGalleryProps) {
  const entries = collectVqaSteps(journeys);

  if (entries.length === 0) {
    return (
      <div
        style={{
          padding: '28px 20px',
          textAlign: 'center',
          color: 'var(--text-mute)',
          fontSize: 12,
          fontFamily: 'var(--font-mono)',
          border: '1px dashed var(--border-2)',
          borderRadius: 8,
        }}
      >
        No before/after VQA evidence for this run.
      </div>
    );
  }

  return (
    <section
      aria-label="Before/after VQA gallery"
      style={{ display: 'flex', flexDirection: 'column', gap: 12 }}
    >
      <header style={{ display: 'flex', alignItems: 'baseline', gap: 10, flexWrap: 'wrap' }}>
        <span style={{ fontSize: 14, fontWeight: 600, color: 'var(--foreground)' }}>
          Before / after — visual judge
        </span>
        <span style={{ fontSize: 11, color: 'var(--text-mute)' }}>
          {entries.length} step{entries.length === 1 ? '' : 's'} judged
        </span>
      </header>

      {entries.map((entry) => (
        <VqaStepCard key={entry.key} entry={entry} />
      ))}
    </section>
  );
}

// ── Step card ─────────────────────────────────────────────────────────

function VqaStepCard({ entry }: { entry: VqaStepEntry }) {
  const color = verdictBorderColor(entry.verdict);
  return (
    <div
      style={{
        border: `1px solid ${color}`,
        borderRadius: 8,
        background: 'var(--bg-elev)',
        padding: '14px 16px',
        display: 'flex',
        flexDirection: 'column',
        gap: 12,
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'baseline',
          justifyContent: 'space-between',
          gap: 10,
          flexWrap: 'wrap',
        }}
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
          <span
            style={{
              fontFamily: 'var(--font-mono)',
              fontSize: 10,
              color: 'var(--accent-blue)',
              letterSpacing: '0.06em',
            }}
          >
            {entry.journeyTitle}
          </span>
          <span style={{ fontSize: 12.5, color: 'var(--text-dim)' }}>{entry.stepLabel}</span>
        </div>
        <StatusChip status={entry.verdict} />
      </div>

      {/* Before/after PAIR — always both slots rendered, never a single frame. */}
      <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap' }}>
        <Frame label="Before" src={entry.beforeShotUrl} borderColor={color} />
        <Frame label="After" src={entry.afterShotUrl} borderColor={color} />
      </div>

      {entry.rationale && (
        <Field label="What the judge saw">
          <p
            style={{
              margin: 0,
              fontSize: 12.5,
              lineHeight: 1.5,
              color: 'var(--text-dim)',
              padding: '9px 12px',
              borderLeft: `3px solid ${color}`,
              background: 'var(--surface)',
              borderRadius: 4,
            }}
          >
            {entry.rationale}
          </p>
        </Field>
      )}

      {entry.sourceDiffRef && (
        <Field label="Source diff the judge saw">
          {isDiffRefUrl(entry.sourceDiffRef) ? (
            <a
              href={entry.sourceDiffRef}
              target="_blank"
              rel="noopener noreferrer"
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 5,
                fontFamily: 'var(--font-mono)',
                fontSize: 11,
                color: 'var(--accent-blue)',
                textDecoration: 'none',
                overflowWrap: 'anywhere',
              }}
            >
              {entry.sourceDiffRef}
              <ExternalLink size={10} style={{ flexShrink: 0 }} />
            </a>
          ) : (
            <code
              style={{
                fontFamily: 'var(--font-mono)',
                fontSize: 11,
                color: 'var(--text-dim)',
                overflowWrap: 'anywhere',
              }}
            >
              {entry.sourceDiffRef}
            </code>
          )}
        </Field>
      )}
    </div>
  );
}

// ── Frame — one labeled, open-in-new-tab evidence slot ───────────────

function Frame({ label, src, borderColor }: { label: string; src: string; borderColor: string }) {
  return (
    <div
      style={{
        flex: '1 1 220px',
        minWidth: 180,
        display: 'flex',
        flexDirection: 'column',
        gap: 5,
      }}
    >
      <span
        style={{
          fontFamily: 'var(--font-mono)',
          fontSize: 8.5,
          color: 'var(--text-faint)',
          textTransform: 'uppercase',
          letterSpacing: '0.18em',
        }}
      >
        {label}
      </span>
      {src ? (
        <a
          href={src}
          target="_blank"
          rel="noopener noreferrer"
          title={`Open ${label.toLowerCase()} frame in a new tab`}
          style={{ display: 'block', textDecoration: 'none' }}
        >
          <EvidenceImage
            src={src}
            alt={`${label} frame`}
            width="100%"
            height={160}
            borderColor={borderColor}
          />
        </a>
      ) : (
        <EvidenceImage
          src={src}
          alt={`${label} frame`}
          width="100%"
          height={160}
          borderColor={borderColor}
        />
      )}
    </div>
  );
}
