'use client';

/**
 * Verdict strip — sticky top of the QA Review page.
 *
 * Layout (left → right):
 *   [VERDICT PILL]  [AC gauge]  [VQA gauge]  [GATE gauge]  [rigor pill]  ·  [Re-run QA]  [Promote →]
 *
 * The verdict pill + gauges are reactive; the CTAs are wired to the
 * `useRunQaReview` mutation + a router push to the Developing→Deploy sub-tab
 * once the plan flips to `ready`.
 */

import { Loader2, RefreshCw, ArrowRight, Send } from 'lucide-react';
import { useRouter, useSearchParams } from 'next/navigation';
import type { QaReport, PlanQaVerdict, QaPillarVerdict } from '@/types/qa-report';
import { useRunQaReview, useSendBackFailing } from '@/hooks/use-qa-report';

interface Props {
  report: QaReport;
  planId: string;
  /** Show the "Last run" relative-time label. */
  showLastRun?: boolean;
}

const VERDICT_META: Record<PlanQaVerdict, { label: string; color: string; help: string }> = {
  ready: {
    label: 'Ready to publish',
    color: 'var(--success)',
    help: 'All pillars green. Click Promote to move on to Deploy.',
  },
  'needs-attention': {
    label: 'Needs attention',
    color: 'var(--warning)',
    help: 'Pending items or partial passes. Drill into failing pillars.',
  },
  blocking: {
    label: 'Blocking',
    color: 'var(--destructive)',
    help: 'At least one pillar is failing. Publish is locked.',
  },
  'not-run': {
    label: 'Not run',
    color: 'var(--text-mute)',
    help: 'No QA data yet. Click Run QA Review to kick it off.',
  },
};

export function VerdictStrip({ report, planId, showLastRun = true }: Props) {
  const router = useRouter();
  const params = useSearchParams();
  const runQa = useRunQaReview(planId);
  const sendBackFailing = useSendBackFailing(planId);
  const verdict = VERDICT_META[report.verdict];
  const failingCount = report.vqa.failures?.length ?? 0;
  const ready = report.verdict === 'ready';

  function onRunQa() {
    runQa.mutate();
  }
  function onPromote() {
    const sp = new URLSearchParams(params.toString());
    sp.set('stage', 'deploy');
    sp.delete('subtab');
    router.replace(`/labs/?${sp.toString()}`);
  }

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
      {/* Big verdict pill */}
      <div
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: 10,
          padding: '8px 16px',
          border: `1px solid ${verdict.color}`,
          background: `color-mix(in srgb, ${verdict.color} 8%, transparent)`,
          borderRadius: 2,
        }}
      >
        <span
          style={{
            background: verdict.color,
            width: 8,
            height: 8,
            borderRadius: '50%',
            display: 'inline-block',
            boxShadow:
              report.verdict === 'blocking' || report.verdict === 'needs-attention'
                ? `0 0 10px ${verdict.color}`
                : 'none',
          }}
        />
        <span
          style={{
            fontFamily: 'var(--font-mono)',
            fontSize: 11,
            color: verdict.color,
            textTransform: 'uppercase',
            letterSpacing: '0.18em',
            fontWeight: 500,
          }}
        >
          {verdict.label}
        </span>
      </div>

      {/* Pillar mini-gauges */}
      <MiniGauge
        label="AC"
        verdict={report.ac.verdict}
        pass={report.ac.pass}
        total={report.ac.total}
      />
      <MiniGauge
        label="VQA"
        verdict={report.vqa.verdict}
        pass={report.vqa.pass}
        total={report.vqa.total}
      />
      <MiniGauge
        label="Gate"
        verdict={report.gate.verdict}
        // For the Gate pillar we don't have a simple "pass/total" but we can
        // surface total rows × active checks. Skipped pillars render `—`.
        pass={countGatePass(report)}
        total={report.gate.waveRows.length * report.gate.activeChecks.length}
      />

      {/* Rigor + auto-QA pills */}
      <RigorPill rigor={report.rigor} hasBrowser={report.hasBrowserTests} />

      {/* Last run */}
      {showLastRun && report.runHistory.length > 0 && (
        <span
          style={{
            fontFamily: 'var(--font-mono)',
            fontSize: 10,
            color: 'var(--text-mute)',
            letterSpacing: '0.06em',
          }}
        >
          Last run · {relTime(report.runHistory[report.runHistory.length - 1].ranAt)}
        </span>
      )}

      {/* Right-side CTAs */}
      <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 10 }}>
        {sendBackFailing.data && (
          <span
            style={{
              fontFamily: 'var(--font-mono)',
              fontSize: 10,
              letterSpacing: '0.04em',
              color: 'var(--text-dim)',
            }}
          >
            ↩ {sendBackFailing.data.sentBack.length} sent
            {sendBackFailing.data.capped.length > 0
              ? ` · ${sendBackFailing.data.capped.length} capped`
              : ''}
          </span>
        )}
        {failingCount > 0 && (
          <button
            type="button"
            onClick={() => {
              if (!sendBackFailing.isPending) sendBackFailing.mutate();
            }}
            disabled={sendBackFailing.isPending}
            title={`Send all ${failingCount} failing visual-QA story(ies) back to dev, grouped by story with a combined note. A wave already bounced 3× is refused (raises an attention item).`}
            style={{
              fontSize: 10,
              letterSpacing: '0.14em',
              textTransform: 'uppercase',
              padding: '7px 14px',
              border: '1px solid var(--destructive)',
              borderRadius: 2,
              color: 'var(--destructive)',
              background: 'color-mix(in srgb, var(--destructive) 10%, transparent)',
              fontWeight: 500,
              cursor: sendBackFailing.isPending ? 'not-allowed' : 'pointer',
              opacity: sendBackFailing.isPending ? 0.6 : 1,
              display: 'inline-flex',
              alignItems: 'center',
              gap: 6,
            }}
          >
            {sendBackFailing.isPending ? (
              <Loader2 size={10} className="animate-spin" />
            ) : (
              <Send size={10} />
            )}
            Send all failing back ({failingCount})
          </button>
        )}
        <RunQaButton report={report} runQa={runQa} onClick={onRunQa} />
        <button
          type="button"
          onClick={onPromote}
          disabled={!ready}
          title={
            ready
              ? 'Proceed to Developing → Deploy to publish'
              : (report.blockingReason ?? 'Waiting for QA verdict')
          }
          style={{
            fontSize: 10,
            letterSpacing: '0.14em',
            textTransform: 'uppercase',
            padding: '7px 14px',
            border: ready ? '1px solid var(--success)' : '1px solid var(--border-2)',
            borderRadius: 2,
            color: ready ? 'var(--success)' : 'var(--text-faint)',
            background: ready
              ? 'color-mix(in srgb, var(--success) 10%, transparent)'
              : 'transparent',
            fontWeight: 500,
            cursor: ready ? 'pointer' : 'not-allowed',
            display: 'inline-flex',
            alignItems: 'center',
            gap: 6,
          }}
        >
          Promote to Deploy
          <ArrowRight size={10} />
        </button>
      </div>
    </div>
  );
}

/**
 * Re-run / Run / Re-classify CTA — labelled based on `vqa.executeStatus`
 * so the operator always sees what clicking will do *now*:
 *
 *   never-run        → "Run QA Review"     (kicks off aggregate)
 *   queued-contract  → "Re-classify"       (re-runs aggregate; discards
 *                                            the current pending contract.
 *                                            Hover hint warns about discard)
 *   rejected         → "Re-classify"       (same — operator wants a fresh
 *                                            contract after declining)
 *   queued-execute   → disabled "QA queued" (daemon hasn't picked up; don't
 *                                             stomp the in-flight job)
 *   running          → disabled "QA running"
 *   done             → "Re-run QA"         (re-aggregates for a fresh pass)
 */
function RunQaButton({
  report,
  runQa,
  onClick,
}: {
  report: QaReport;
  runQa: ReturnType<typeof useRunQaReview>;
  onClick: () => void;
}) {
  const status = report.vqa.executeStatus;
  const blocked = status === 'queued-execute' || status === 'running';
  const label = runQa.isPending
    ? 'Enqueueing…'
    : status === 'never-run'
      ? 'Run QA Review'
      : status === 'queued-contract' || status === 'rejected'
        ? 'Re-classify'
        : status === 'queued-execute'
          ? 'QA queued'
          : status === 'running'
            ? 'QA running'
            : 'Re-run QA';
  const title = blocked
    ? status === 'queued-execute'
      ? 'Execute job is queued for the daemon — wait for it to pick up.'
      : 'Execute job is running — wait for screenshots, then Re-run QA if needed.'
    : status === 'queued-contract'
      ? 'Re-runs the aggregate step; the current pending contract will be discarded.'
      : status === 'rejected'
        ? 'Run a fresh aggregate so the contract gate re-appears.'
        : status === 'never-run'
          ? 'Run QA for the first time'
          : 'Re-run Visual QA across all epics';
  const disabled = runQa.isPending || blocked;
  // dragon1 (2026-06-10) — the launch endpoint 400s with a real reason
  // (e.g. 'No visual tests defined in any story across the plan') but the
  // mutation error was never rendered: clicking the button looked like a
  // no-op. Surface the message inline so the operator knows WHY.
  const errMsg = runQa.isError
    ? runQa.error instanceof Error
      ? runQa.error.message
      : String(runQa.error)
    : null;
  return (
    <span
      style={{ display: 'inline-flex', flexDirection: 'column', alignItems: 'flex-end', gap: 4 }}
    >
      <button
        type="button"
        onClick={onClick}
        disabled={disabled}
        style={{
          fontSize: 10,
          letterSpacing: '0.14em',
          textTransform: 'uppercase',
          padding: '7px 14px',
          border: '1px solid var(--border-2)',
          borderRadius: 2,
          color: 'var(--text-dim)',
          background: 'transparent',
          cursor: disabled ? 'not-allowed' : 'pointer',
          display: 'inline-flex',
          alignItems: 'center',
          gap: 6,
          opacity: disabled ? 0.5 : 1,
        }}
        title={title}
      >
        {runQa.isPending ? <Loader2 size={10} className="animate-spin" /> : <RefreshCw size={10} />}
        {label}
      </button>
      {errMsg && (
        <span
          style={{
            fontSize: 10,
            color: 'var(--warning)',
            maxWidth: 280,
            textAlign: 'right',
            lineHeight: 1.4,
          }}
        >
          {errMsg}
        </span>
      )}
    </span>
  );
}

// ── Helpers ──────────────────────────────────────────────────────────

function countGatePass(report: QaReport): number {
  let n = 0;
  for (const row of report.gate.waveRows) {
    for (const cell of Object.values(row.cells)) {
      if (cell === 'pass') n += 1;
    }
  }
  return n;
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

function MiniGauge({
  label,
  verdict,
  pass,
  total,
}: {
  label: string;
  verdict: QaPillarVerdict;
  pass: number;
  total: number;
}) {
  const color = verdictColor(verdict);
  const pct = total > 0 ? Math.round((pass / total) * 100) : 0;
  const valueText = verdict === 'skipped' ? '—' : total === 0 ? '—' : `${pass}/${total}`;
  return (
    <div style={{ display: 'inline-flex', flexDirection: 'column', gap: 4 }}>
      <div
        style={{
          display: 'flex',
          alignItems: 'baseline',
          gap: 8,
        }}
      >
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
      </div>
      <div
        style={{
          width: 80,
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
            opacity: verdict === 'skipped' ? 0.2 : 0.9,
            transition: 'width 300ms',
          }}
        />
      </div>
    </div>
  );
}

function RigorPill({ rigor, hasBrowser }: { rigor: string; hasBrowser: boolean }) {
  return (
    <span
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
      }}
      title={
        rigor === 'prototype'
          ? 'Prototype rigor — no automated gate'
          : rigor === 'mvp'
            ? 'MVP rigor — unit tests required'
            : 'Production rigor — full red-green-tamper gate'
      }
    >
      Rigor · {rigor}
      {hasBrowser ? ' + browser' : ''}
    </span>
  );
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
