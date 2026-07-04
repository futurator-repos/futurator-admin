'use client';

/**
 * JourneyVerdicts — Lane 1 (deterministic delivery journeys), QA-Review W2.
 *
 * Renders each PM-declared delivery journey (JourneyResult) as an
 * expand-in-place accordion row (ClaimAccordionRow pattern — see the legacy
 * claims table / bound-ac-table.tsx):
 *   collapsed: title + narrative + pass/fail/uncertain pill (StatusChip)
 *   expanded:  each step's deterministic assertion (passed/failed + detail)
 *              and the acRefs the journey covers.
 *
 * `deriveJourneyVerdict` recomputes the BLOCKING verdict purely from each
 * step's `deterministic` result (Lane 1 is the primary/authoritative verdict
 * — see qa-review-p3.ts:9-12: "A failed assertion BLOCKS") rather than
 * trusting the persisted `JourneyResult.verdict` field, so a stale or
 * mismatched server verdict can never mask a failing assertion in the UI.
 *
 * Presentational only — data comes via props. No data fetching.
 */

import { useState } from 'react';
import { ChevronDown, ChevronRight, CheckCircle2, XCircle } from 'lucide-react';
import type { JourneyResult, JourneyStep, LaneVerdict } from '@/types/qa-review-p3';
import { StatusChip } from './qa-primitives';

// ── Pure helper (exported + unit-tested) ─────────────────────────────

/**
 * The BLOCKING verdict for a journey, derived purely from its steps'
 * deterministic assertions. A single failed assertion fails the whole
 * journey; a journey with no steps is vacuously a pass.
 */
export function deriveJourneyVerdict(steps: JourneyStep[]): LaneVerdict {
  return steps.some((step) => !step.deterministic.passed) ? 'fail' : 'pass';
}

// ── acRefs chip ───────────────────────────────────────────────────────

function AcRefChip({ acRef }: { acRef: string }) {
  return (
    <code
      style={{
        fontFamily: 'var(--font-mono)',
        fontSize: 10,
        color: 'var(--accent-blue)',
        border: '1px solid color-mix(in srgb, var(--accent-blue) 40%, transparent)',
        background: 'color-mix(in srgb, var(--accent-blue) 6%, transparent)',
        borderRadius: 3,
        padding: '1px 6px',
        whiteSpace: 'nowrap',
      }}
    >
      {acRef}
    </code>
  );
}

// ── Step row — expanded deterministic assertion detail ───────────────

function StepRow({ step }: { step: JourneyStep }) {
  const { deterministic } = step;
  const color = deterministic.passed ? 'var(--success)' : 'var(--destructive)';
  return (
    <div
      style={{
        display: 'flex',
        gap: 10,
        alignItems: 'flex-start',
        padding: '8px 0',
        borderTop: '1px dashed var(--border)',
      }}
    >
      {deterministic.passed ? (
        <CheckCircle2 size={14} style={{ color, flexShrink: 0, marginTop: 2 }} aria-hidden />
      ) : (
        <XCircle size={14} style={{ color, flexShrink: 0, marginTop: 2 }} aria-hidden />
      )}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 3, flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 12.5, color: 'var(--foreground)', lineHeight: 1.4 }}>
          <span
            style={{
              color: 'var(--text-faint)',
              fontFamily: 'var(--font-mono)',
              fontSize: 10.5,
              marginRight: 8,
            }}
          >
            {step.action}
          </span>
          {deterministic.assertion}
        </div>
        <div
          style={{
            fontSize: 11,
            lineHeight: 1.4,
            fontFamily: 'var(--font-mono)',
            color: deterministic.passed ? 'var(--text-mute)' : 'var(--destructive)',
          }}
        >
          {deterministic.detail}
        </div>
      </div>
    </div>
  );
}

// ── Accordion row ────────────────────────────────────────────────────

function JourneyAccordionRow({
  journey,
  open,
  onToggle,
}: {
  journey: JourneyResult;
  open: boolean;
  onToggle: () => void;
}) {
  const verdict = deriveJourneyVerdict(journey.steps);

  return (
    <div
      style={{
        border: '1px solid var(--border)',
        borderRadius: 8,
        background: 'var(--bg-elev)',
        overflow: 'hidden',
      }}
    >
      <div
        role="button"
        tabIndex={0}
        aria-expanded={open}
        onClick={onToggle}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            onToggle();
          }
        }}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 10,
          padding: '11px 14px',
          cursor: 'pointer',
          background: open ? 'color-mix(in srgb, var(--accent-blue) 4%, transparent)' : undefined,
        }}
      >
        {open ? (
          <ChevronDown size={14} style={{ color: 'var(--text-mute)', flexShrink: 0 }} />
        ) : (
          <ChevronRight size={14} style={{ color: 'var(--text-faint)', flexShrink: 0 }} />
        )}

        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--foreground)' }}>
            {journey.title}
          </div>
          {journey.narrative && (
            <div
              style={{
                fontSize: 11.5,
                color: 'var(--text-mute)',
                marginTop: 2,
                lineHeight: 1.4,
                ...(open
                  ? {}
                  : {
                      display: '-webkit-box',
                      WebkitLineClamp: 1,
                      WebkitBoxOrient: 'vertical' as const,
                      overflow: 'hidden',
                    }),
              }}
            >
              {journey.narrative}
            </div>
          )}
        </div>

        <StatusChip status={verdict} />
      </div>

      {open && (
        <div style={{ padding: '2px 16px 14px 40px' }}>
          {journey.acRefs.length > 0 && (
            <div
              style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 6, marginBottom: 8 }}
            >
              {journey.acRefs.map((ref) => (
                <AcRefChip key={ref} acRef={ref} />
              ))}
            </div>
          )}

          {journey.steps.length === 0 ? (
            <div
              style={{
                fontSize: 11.5,
                color: 'var(--text-faint)',
                fontStyle: 'italic',
                padding: '6px 0',
              }}
            >
              No steps recorded for this journey.
            </div>
          ) : (
            journey.steps.map((step, i) => <StepRow key={`${journey.id}-${i}`} step={step} />)
          )}
        </div>
      )}
    </div>
  );
}

// ── Main export ──────────────────────────────────────────────────────

export interface JourneyVerdictsProps {
  journeys: JourneyResult[];
}

export function JourneyVerdicts({ journeys }: JourneyVerdictsProps) {
  const [openId, setOpenId] = useState<string | null>(null);

  if (journeys.length === 0) {
    return (
      <div
        style={{
          padding: '48px 24px',
          textAlign: 'center',
          color: 'var(--text-mute)',
          fontSize: 12.5,
          fontFamily: 'var(--font-mono)',
          letterSpacing: '0.06em',
          lineHeight: 1.6,
        }}
      >
        No delivery journeys run yet. QA Review runs the PM&apos;s delivery journeys against the
        deployed dev preview once the plan reaches{' '}
        <code style={{ color: 'var(--accent-blue)' }}>review</code>.
      </div>
    );
  }

  return (
    <section
      aria-label="Delivery journey verdicts"
      style={{ display: 'flex', flexDirection: 'column', gap: 10 }}
    >
      {journeys.map((journey) => (
        <JourneyAccordionRow
          key={journey.id}
          journey={journey}
          open={openId === journey.id}
          onToggle={() => setOpenId((cur) => (cur === journey.id ? null : journey.id))}
        />
      ))}
    </section>
  );
}
