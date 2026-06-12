'use client';

/**
 * QA Review view — pacman1 UX pass (2026-06-12).
 *
 * Layout (top → bottom), designed to be self-explanatory for semi-technical
 * readers (PMs, scrum masters) while staying explorable for operators:
 *
 *   [VERDICT STRIP — sticky: the one-line shipping decision]
 *   [CONTRACT GATE / RUNNING banner — only when relevant]
 *   [AC failures — only when explicit criteria failures exist]
 *   [CLAIMS — the centerpiece: every visual claim with inline expanders]
 *   [QUALITY GATES — per-epic collapsible stage outcomes]
 *   [QA RUN — compact card, technical log collapsed]
 *   [AUDIT TIMELINE]
 *
 * Removed by operator decree: the three big pillar cards (redundant with the
 * verdict strip), the side drawer (claims expand in place), the daemon
 * status strip (the header owns that signal), the extracted-variables dump.
 */

import { Check, Loader2, Undo2 } from 'lucide-react';
import { useQaReport, useApproveAc, useRevokeAcApproval } from '@/hooks/use-qa-report';
import type { QaReport } from '@/types/qa-report';
import { VerdictStrip } from './qa/verdict-strip';
import { ClaimsTable } from './qa/claims-table';
import { WaveMatrix } from './qa/wave-matrix';
import { AuditTimeline } from './qa/audit-timeline';
import { VqaLogs } from './qa/vqa-logs';
import { ContractGate } from './qa/contract-gate';

export function QaReviewView({ planId }: { planId: string }) {
  const { data: report, isLoading, error } = useQaReport(planId);

  if (isLoading) {
    return (
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          padding: 80,
          color: 'var(--text-mute)',
          gap: 10,
          fontFamily: 'var(--font-mono)',
          fontSize: 12,
          letterSpacing: '0.08em',
          textTransform: 'uppercase',
        }}
      >
        <Loader2 size={14} className="animate-spin" />
        Loading QA report…
      </div>
    );
  }
  if (error || !report) {
    return (
      <div
        style={{
          padding: 24,
          border: '1px solid var(--destructive)',
          background: 'color-mix(in srgb, var(--destructive) 10%, transparent)',
          borderRadius: 8,
          color: 'var(--destructive)',
          fontSize: 13,
        }}
      >
        Couldn&apos;t load QA report.
        {error instanceof Error ? ` · ${error.message}` : ''}
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <VerdictStrip report={report} planId={planId} />
      <ContractGate report={report} planId={planId} />
      <RunningBanner report={report} />

      {/* Acceptance-criteria section — only surfaces when there is something
          an operator must act on (explicit failures, or the manual sign-off
          affordance). The healthy auto-pass state lives in the strip. */}
      <AcSection report={report} planId={planId} />

      {/* The centerpiece: every visual claim, expandable in place. */}
      {(report.vqa.results?.length ?? 0) > 0 && <ClaimsTable report={report} planId={planId} />}

      {/* Per-epic quality gates with real stage outcomes. */}
      {report.gate.verdict !== 'skipped' && <WaveMatrix rollup={report.gate} />}

      {/* QA run summary (technical log collapsed inside). */}
      {(report.qaRuns?.length ?? 0) > 0 && <VqaLogs runs={report.qaRuns} />}

      {report.attentionItems.length > 0 && <AttentionBanner count={report.attentionItems.length} />}

      <AuditTimeline report={report} />
    </div>
  );
}

// ── Acceptance criteria (failures + manual sign-off only) ───────────

function AcSection({ report, planId }: { report: QaReport; planId: string }) {
  const { ac } = report;
  const approve = useApproveAc(planId);
  const revoke = useRevokeAcApproval(planId);

  const hasFailures = ac.failures.length > 0;
  const showSignOff = ac.canManuallyApprove || !!ac.manualApproval;
  if (!hasFailures && !showSignOff) return null;

  return (
    <section
      aria-label="Acceptance criteria"
      style={{
        border: `1px solid ${hasFailures ? 'var(--destructive)' : 'var(--border)'}`,
        background: hasFailures
          ? 'color-mix(in srgb, var(--destructive) 4%, var(--bg-elev))'
          : 'var(--bg-elev)',
        borderRadius: 10,
        padding: '14px 18px',
        display: 'flex',
        flexDirection: 'column',
        gap: 10,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
        <span style={{ fontSize: 13.5, fontWeight: 600, color: 'var(--foreground)' }}>
          Acceptance criteria
        </span>
        <span style={{ fontSize: 11.5, color: 'var(--text-mute)' }}>
          {ac.pass}/{ac.total} passing
          {report.rigor !== 'production' && !ac.manualApproval
            ? ' · auto-approved when a story completes (below production rigor)'
            : ''}
        </span>
        <span style={{ marginLeft: 'auto', display: 'flex', gap: 8 }}>
          {ac.canManuallyApprove && (
            <button
              type="button"
              onClick={() => approve.mutate()}
              disabled={approve.isPending}
              style={smallBtn('var(--success)', approve.isPending)}
            >
              {approve.isPending ? (
                <Loader2 size={11} className="animate-spin" />
              ) : (
                <Check size={11} />
              )}
              Mark AC reviewed
            </button>
          )}
          {ac.manualApproval && (
            <button
              type="button"
              onClick={() => revoke.mutate()}
              disabled={revoke.isPending}
              style={smallBtn('var(--text-mute)', revoke.isPending)}
            >
              {revoke.isPending ? (
                <Loader2 size={11} className="animate-spin" />
              ) : (
                <Undo2 size={11} />
              )}
              Undo approval
            </button>
          )}
        </span>
      </div>

      {hasFailures && (
        <ul style={{ listStyle: 'none', margin: 0, padding: 0 }}>
          {ac.failures.map((f) => (
            <li
              key={`${f.storyId}:${f.criterionId}`}
              style={{
                display: 'flex',
                gap: 10,
                alignItems: 'baseline',
                padding: '7px 0',
                borderTop: '1px solid var(--border)',
                fontSize: 12.5,
              }}
            >
              <code style={{ fontSize: 10, color: 'var(--destructive)', flexShrink: 0 }}>
                {f.criterionId}
              </code>
              <span style={{ color: 'var(--text-dim)', flex: 1, lineHeight: 1.45 }}>{f.text}</span>
              {f.poNote && (
                <span style={{ fontSize: 11, color: 'var(--warning)', flexShrink: 0 }}>
                  PO: {f.poNote.slice(0, 80)}
                </span>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function smallBtn(color: string, busy: boolean): React.CSSProperties {
  return {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 6,
    fontSize: 10.5,
    padding: '5px 11px',
    border: `1px solid ${color}`,
    borderRadius: 5,
    background: `color-mix(in srgb, ${color} 8%, transparent)`,
    color,
    fontWeight: 500,
    letterSpacing: '0.06em',
    cursor: busy ? 'not-allowed' : 'pointer',
    opacity: busy ? 0.6 : 1,
  };
}

// ── Banners ─────────────────────────────────────────────────────────

function AttentionBanner({ count }: { count: number }) {
  return (
    <div
      style={{
        padding: '10px 14px',
        border: '1px solid var(--border)',
        borderRadius: 8,
        background: 'color-mix(in srgb, var(--warning) 6%, transparent)',
        color: 'var(--warning)',
        fontSize: 12,
        fontFamily: 'var(--font-mono)',
        letterSpacing: '0.04em',
      }}
    >
      {count} QA-related attention item{count === 1 ? '' : 's'} · open the bell (top-right of hero)
      to triage.
    </div>
  );
}

/**
 * Running banner — shown when qa-execute is in flight (or queued for the
 * daemon). Re-derived from `vqa.executeStatus` (plan-scoped QA).
 */
function RunningBanner({ report }: { report: QaReport }) {
  const status = report.vqa.executeStatus;
  if (status !== 'running' && status !== 'queued-execute') return null;
  const label = status === 'running' ? 'QA running' : 'QA queued';
  return (
    <div
      style={{
        padding: '12px 16px',
        border: '1px solid var(--accent-purple)',
        background: 'color-mix(in srgb, var(--accent-purple) 10%, transparent)',
        borderRadius: 8,
        display: 'flex',
        alignItems: 'center',
        gap: 12,
        fontFamily: 'var(--font-mono)',
        fontSize: 12,
        flexWrap: 'wrap',
      }}
    >
      <Loader2 size={14} className="animate-spin" style={{ color: 'var(--accent-purple)' }} />
      <span style={{ color: 'var(--foreground)', fontWeight: 500, letterSpacing: '0.02em' }}>
        {label}
      </span>
      <span style={{ color: 'var(--text-mute)', letterSpacing: '0.06em' }}>
        {status === 'queued-execute'
          ? 'Daemon will pick up the execute job within ~60s.'
          : 'Capturing screenshots + judging tests · open the QA run card below for the live log'}
      </span>
    </div>
  );
}
