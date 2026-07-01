'use client';

/**
 * Labs3 verdict strip — sticky top of QaReviewView.
 *
 * Derives a delivery verdict purely from StoryNodeRow[]:
 *   all done    → ready
 *   any failed  → blocking
 *   else        → in-progress (or not-started)
 *
 * Gauges:
 *   Story completion  (done / total)
 *   Deterministic ACs (passing / total deterministic)
 *   Advisory ACs      (passing / total advisory) — shown when > 0
 *
 * Read-only — no CTAs, no send-back, no deploy promotion.
 * The pipeline executor is the authority; this view observes.
 */

import { useMemo } from 'react';
import type { StoryNodeRow } from '@/types/plan-spec';

// ── Verdict derivation ───────────────────────────────────────────────

type DeliveryVerdict = 'ready' | 'blocking' | 'in-progress' | 'not-started';

const VERDICT_META: Record<DeliveryVerdict, { label: string; color: string; help: string }> = {
  ready: {
    label: 'Ready to deliver',
    color: 'var(--success)',
    help: 'All stories done. Deterministic ACs are passing.',
  },
  blocking: {
    label: 'Blocking',
    color: 'var(--destructive)',
    help: 'One or more stories failed. Fix failures before delivering.',
  },
  'in-progress': {
    label: 'In progress',
    color: 'var(--warning)',
    help: 'Stories are still running. Check back when the plan completes.',
  },
  'not-started': {
    label: 'Not started',
    color: 'var(--text-mute)',
    help: 'No stories have run yet.',
  },
};

function deriveVerdict(stories: StoryNodeRow[]): DeliveryVerdict {
  if (stories.length === 0) return 'not-started';
  if (stories.some((s) => s.state === 'failed')) return 'blocking';
  if (stories.every((s) => s.state === 'done')) return 'ready';
  return 'in-progress';
}

// ── AC gauges ────────────────────────────────────────────────────────

interface AcGauges {
  deterministicPass: number;
  deterministicTotal: number;
  advisoryPass: number;
  advisoryTotal: number;
}

function computeAcGauges(stories: StoryNodeRow[]): AcGauges {
  let deterministicPass = 0;
  let deterministicTotal = 0;
  let advisoryPass = 0;
  let advisoryTotal = 0;

  for (const story of stories) {
    for (const ac of story.acceptanceCriteria) {
      if (ac.acClass === 'deterministic') {
        deterministicTotal += 1;
        if (ac.testBinding.status === 'passing') deterministicPass += 1;
      } else {
        advisoryTotal += 1;
        if (ac.testBinding.status === 'passing') advisoryPass += 1;
      }
    }
  }
  return { deterministicPass, deterministicTotal, advisoryPass, advisoryTotal };
}

// ── Component ────────────────────────────────────────────────────────

export function VerdictStrip({ stories }: { stories: StoryNodeRow[] }) {
  const verdict = useMemo(() => deriveVerdict(stories), [stories]);
  const gauges = useMemo(() => computeAcGauges(stories), [stories]);
  const meta = VERDICT_META[verdict];

  const doneStories = useMemo(() => stories.filter((s) => s.state === 'done').length, [stories]);
  const failedStories = useMemo(
    () => stories.filter((s) => s.state === 'failed').length,
    [stories],
  );

  return (
    <div
      style={{
        position: 'sticky',
        top: 0,
        zIndex: 30,
        background: 'var(--background)',
        borderBottom: '1px solid var(--border)',
        padding: '14px 0',
        display: 'flex',
        alignItems: 'center',
        gap: 20,
        flexWrap: 'wrap',
      }}
    >
      {/* Verdict pill */}
      <div
        title={meta.help}
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: 10,
          padding: '8px 16px',
          border: `1px solid ${meta.color}`,
          background: `color-mix(in srgb, ${meta.color} 8%, transparent)`,
          borderRadius: 2,
        }}
      >
        <span
          style={{
            background: meta.color,
            width: 8,
            height: 8,
            borderRadius: '50%',
            display: 'inline-block',
            boxShadow: verdict === 'blocking' ? `0 0 10px ${meta.color}` : 'none',
          }}
        />
        <span
          style={{
            fontFamily: 'var(--font-mono)',
            fontSize: 11,
            color: meta.color,
            textTransform: 'uppercase',
            letterSpacing: '0.18em',
            fontWeight: 500,
          }}
        >
          {meta.label}
        </span>
      </div>

      {/* Story completion gauge */}
      <MiniGauge
        label="Stories"
        pass={doneStories}
        total={stories.length}
        color={
          verdict === 'ready'
            ? 'var(--success)'
            : failedStories > 0
              ? 'var(--destructive)'
              : doneStories > 0
                ? 'var(--warning)'
                : 'var(--text-mute)'
        }
      />

      {/* Deterministic AC gauge */}
      <MiniGauge
        label="Deterministic AC"
        pass={gauges.deterministicPass}
        total={gauges.deterministicTotal}
        color={
          gauges.deterministicTotal === 0
            ? 'var(--text-faint)'
            : gauges.deterministicPass === gauges.deterministicTotal
              ? 'var(--success)'
              : gauges.deterministicPass > 0
                ? 'var(--warning)'
                : 'var(--text-mute)'
        }
      />

      {/* Advisory AC gauge — only if any exist */}
      {gauges.advisoryTotal > 0 && (
        <MiniGauge
          label="Advisory AC"
          pass={gauges.advisoryPass}
          total={gauges.advisoryTotal}
          color="var(--text-dim)"
          note="non-blocking"
        />
      )}

      {/* Read-only badge — right-aligned */}
      <span
        title="Labs3 QA view is read-only — the pipeline executor writes testBinding states"
        style={{
          fontFamily: 'var(--font-mono)',
          fontSize: 9,
          color: 'var(--text-dim)',
          textTransform: 'uppercase',
          letterSpacing: '0.2em',
          padding: '4px 10px',
          borderRadius: 2,
          border: '1px solid var(--border-2)',
          background: 'transparent',
          marginLeft: 'auto',
        }}
      >
        bound-AC · read-only
      </span>
    </div>
  );
}

// ── Mini gauge (mirrors legacy verdict-strip MiniGauge exactly) ──────

function MiniGauge({
  label,
  pass,
  total,
  color,
  note,
}: {
  label: string;
  pass: number;
  total: number;
  color: string;
  note?: string;
}) {
  const pct = total > 0 ? Math.round((pass / total) * 100) : 0;
  const valueText = total === 0 ? '—' : `${pass}/${total}`;

  return (
    <div style={{ display: 'inline-flex', flexDirection: 'column', gap: 4 }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
        <span
          style={{
            fontFamily: 'var(--font-mono)',
            fontSize: 8,
            color: 'var(--text-faint)',
            textTransform: 'uppercase',
            letterSpacing: '0.22em',
          }}
        >
          {label}
        </span>
        <span
          style={{
            fontFamily: 'var(--font-mono)',
            fontSize: 13,
            color,
            fontWeight: 500,
            letterSpacing: '0.01em',
          }}
        >
          {valueText}
        </span>
        {note && (
          <span
            style={{
              fontFamily: 'var(--font-mono)',
              fontSize: 8,
              color: 'var(--text-mute)',
              letterSpacing: '0.08em',
              textTransform: 'uppercase',
            }}
          >
            {note}
          </span>
        )}
      </div>
      <div style={{ width: 80, height: 2, background: 'var(--border)', overflow: 'hidden' }}>
        <div
          style={{
            width: `${pct}%`,
            height: '100%',
            background: color,
            opacity: total === 0 ? 0.2 : 0.9,
            transition: 'width 300ms',
          }}
        />
      </div>
    </div>
  );
}
