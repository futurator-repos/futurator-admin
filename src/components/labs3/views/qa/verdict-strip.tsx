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
import type { QaReadiness } from '@/hooks/use-p3-qa-report';
import { advisoryChipState, type AcWithAdvisoryVqa } from './bound-ac-table';

// ── Verdict derivation ───────────────────────────────────────────────

type DeliveryVerdict = 'ready' | 'blocking' | 'in-progress' | 'not-started' | 'qa-pending';

const VERDICT_META: Record<DeliveryVerdict, { label: string; color: string; help: string }> = {
  ready: {
    label: 'Ready to deliver',
    color: 'var(--success)',
    help: 'Deployed-app QA verified. Deterministic ACs are passing.',
  },
  blocking: {
    label: 'Blocking',
    color: 'var(--destructive)',
    help: 'One or more stories failed, or deployed-app QA is blocking. Fix before delivering.',
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
  'qa-pending': {
    label: 'QA pending — unverified',
    color: 'var(--text-mute)',
    help: 'Unit ACs pass, but deployed-app QA has not verified this commit. Not ready to deliver.',
  },
};

/**
 * Derive the delivery verdict from unit-AC story state, THEN gate it on the
 * deployed-app QA readiness (the FROZEN CONTRACT single source of truth):
 *   readiness 'blocking' → force 'blocking' (never green)
 *   readiness 'pending'  → a would-be 'ready' becomes neutral 'qa-pending'
 *   readiness 'verified' or undefined (flag off / no signal) → the story-derived
 *     verdict stands (legacy behavior when there is no deployed-app QA gate).
 * This prevents the strip from reading green off the unit-AC rollup alone while
 * deployed-app QA is unverified or blocking.
 */
function deriveVerdict(
  stories: StoryNodeRow[],
  securityFailing: number,
  qaReadiness?: QaReadiness,
): DeliveryVerdict {
  const base: DeliveryVerdict =
    stories.length === 0
      ? 'not-started'
      : stories.some((s) => s.state === 'failed')
        ? 'blocking'
        : stories.every((s) => s.state === 'done')
          ? 'ready'
          : 'in-progress';

  // A blocking security-advisory (SEC) reviewer fail must surface even when all
  // stories are 'done' — SEC ACs never gate story state, but per their contract
  // (AC_CLASS_META: "can block on a reviewer fail") they DO block delivery.
  if (qaReadiness === 'blocking' || securityFailing > 0) return 'blocking';
  if (qaReadiness === 'pending' && base === 'ready') return 'qa-pending';
  return base;
}

// ── AC gauges ────────────────────────────────────────────────────────

interface AcGauges {
  deterministicPass: number;
  deterministicTotal: number;
  /** Q1 — observe-only VQA rollup (replaces the old testBinding pass/fail read). Advisory-TASTE only. */
  advisoryVerified: number;
  advisoryAttention: number;
  advisoryNeverRun: number;
  advisoryTotal: number;
  /** SEC (advisory-security) rolls up off testBinding.status — it can block on a reviewer fail. */
  securityTotal: number;
  securityFailing: number;
}

/**
 * Pure — exported for tests. Advisory-TASTE ACs roll up off `advisoryVqa` (never
 * blocking). SEC (advisory-security) ACs are kept OUT of the advisory-taste bucket
 * and rolled up off testBinding.status, so a blocking reviewer fail isn't hidden as
 * a non-blocking "never run".
 */
export function computeAcGauges(stories: StoryNodeRow[]): AcGauges {
  let deterministicPass = 0;
  let deterministicTotal = 0;
  let advisoryVerified = 0;
  let advisoryAttention = 0;
  let advisoryNeverRun = 0;
  let advisoryTotal = 0;
  let securityTotal = 0;
  let securityFailing = 0;

  for (const story of stories) {
    for (const ac of story.acceptanceCriteria as AcWithAdvisoryVqa[]) {
      if (ac.acClass === 'deterministic') {
        deterministicTotal += 1;
        if (ac.testBinding.status === 'passing') deterministicPass += 1;
        continue;
      }
      if (ac.acClass === 'advisory-security') {
        securityTotal += 1;
        if (ac.testBinding.status === 'failing') securityFailing += 1;
        continue;
      }
      // advisory-taste
      advisoryTotal += 1;
      const state = advisoryChipState(ac.advisoryVqa);
      if (state === 'verified') advisoryVerified += 1;
      else if (state === 'never-run') advisoryNeverRun += 1;
      else advisoryAttention += 1; // 'attention' | 'error'
    }
  }
  return {
    deterministicPass,
    deterministicTotal,
    advisoryVerified,
    advisoryAttention,
    advisoryNeverRun,
    advisoryTotal,
    securityTotal,
    securityFailing,
  };
}

// ── Component ────────────────────────────────────────────────────────

export function VerdictStrip({
  stories,
  qaReadiness,
}: {
  stories: StoryNodeRow[];
  /**
   * Deployed-app QA readiness. When provided, gates the verdict so it can't read
   * green while QA is unverified/blocking. Omit (undefined) for legacy behavior
   * when there is no deployed-app QA signal (flag off / no report).
   */
  qaReadiness?: QaReadiness;
}) {
  const gauges = useMemo(() => computeAcGauges(stories), [stories]);
  const verdict = useMemo(
    () => deriveVerdict(stories, gauges.securityFailing, qaReadiness),
    [stories, gauges.securityFailing, qaReadiness],
  );
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

      {/* Advisory AC gauge — Q1 observe-only VQA rollup, only if any exist.
          Counts verified-pass / attention / never-run (not the old testBinding
          pass/fail read, which was a permanent-FAILING lie for these ACs). */}
      {gauges.advisoryTotal > 0 && (
        <MiniGauge
          label="Advisory AC"
          pass={gauges.advisoryVerified}
          total={gauges.advisoryTotal}
          color={gauges.advisoryAttention > 0 ? 'var(--warning)' : 'var(--text-dim)'}
          note={
            gauges.advisoryAttention > 0
              ? `${gauges.advisoryAttention} attention`
              : gauges.advisoryNeverRun > 0
                ? `${gauges.advisoryNeverRun} never run`
                : 'non-blocking'
          }
        />
      )}

      {/* Security AC gauge — SEC (advisory-security) rolls up off testBinding.status
          and CAN block delivery. Shows pass count; a failing reviewer AC forces red. */}
      {gauges.securityTotal > 0 && (
        <MiniGauge
          label="Security AC"
          pass={gauges.securityTotal - gauges.securityFailing}
          total={gauges.securityTotal}
          color={gauges.securityFailing > 0 ? 'var(--destructive)' : 'var(--success)'}
          note={
            gauges.securityFailing > 0 ? `${gauges.securityFailing} blocking` : 'reviewer-gated'
          }
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
