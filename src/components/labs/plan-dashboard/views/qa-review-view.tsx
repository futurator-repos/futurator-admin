'use client';

/**
 * QA Review view — primary content of the QA Review pipeline stage.
 *
 * Layout:
 *   [VERDICT STRIP — sticky]
 *   [ AC CARD ] [ VQA CARD ] [ GATE CARD ]
 *   [ FAILURE DRAWER — right-side, opens on click ]
 *
 * Wave 3 adds the build matrix. Wave 4 the gallery. Wave 5 the audit trail.
 */

import { useState } from 'react';
import { Loader2, Check, Undo2 } from 'lucide-react';
import { useQaReport, useApproveAc, useRevokeAcApproval } from '@/hooks/use-qa-report';
import type { AcCriterionResult, QaReport, VqaTestResult } from '@/types/qa-report';
import { VerdictStrip } from './qa/verdict-strip';
import { PillarCard } from './qa/pillar-card';
import { FailureDrawer, type FailureDrawerItem } from './qa/failure-drawer';
import { WaveMatrix } from './qa/wave-matrix';
import { ClaimsTable } from './qa/claims-table';
import { AuditTimeline } from './qa/audit-timeline';
import { VqaLogs } from './qa/vqa-logs';
import { ContractGate } from './qa/contract-gate';

export function QaReviewView({ planId }: { planId: string }) {
  const { data: report, isLoading, error } = useQaReport(planId);
  const [drawerItem, setDrawerItem] = useState<FailureDrawerItem | null>(null);

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
    <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
      <VerdictStrip report={report} planId={planId} />
      <ContractGate report={report} planId={planId} />
      <RunningBanner report={report} />
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))',
          gap: 14,
        }}
      >
        <AcPillar
          report={report}
          planId={planId}
          onSelect={(i) => setDrawerItem({ kind: 'ac', item: i })}
        />
        <VqaPillar report={report} onSelect={(i) => setDrawerItem({ kind: 'vqa', item: i })} />
        <GatePillar report={report} />
      </div>

      {/* Wave-level build matrix — only visible when gate is active. */}
      {report.gate.verdict !== 'skipped' && (
        <WaveMatrix
          rollup={report.gate}
          onSelectCell={(row, check, cellStatus) =>
            setDrawerItem({ kind: 'gate', row, check, cellStatus })
          }
        />
      )}

      {/* QA-C (pong1 2026-06-12) — the claim-centric table replaces the old
          thumbnail gallery: one row per claim (Epic → Story → AC) with level
          chip, wave-gate verdict arc, final QA verdict, thumbnail. EVERY row
          — pass or fail — opens the universal evidence drawer. */}
      {(report.vqa.results?.length ?? 0) > 0 && (
        <ClaimsTable
          report={report}
          onSelect={({ test, claim }) => setDrawerItem({ kind: 'vqa', item: test, claim })}
        />
      )}

      {/* VQA agent logs — paste-able diagnosis block when VQA misbehaves.
          QA-A: ONE panel per unique QA run (plan-scoped runs no longer
          duplicate per epic). */}
      {(report.qaRuns?.length ?? 0) > 0 && <VqaLogs runs={report.qaRuns} />}

      {/* Attention items chip strip — filtered QA-relevant items, linked to
          the existing right-side dock via the bell on the project hero. */}
      {report.attentionItems.length > 0 && <AttentionBanner count={report.attentionItems.length} />}

      {/* Audit trail — always visible once at least one run has completed. */}
      <AuditTimeline report={report} />

      <FailureDrawer planId={planId} item={drawerItem} onClose={() => setDrawerItem(null)} />
    </div>
  );
}

// ── Pillar renderers ────────────────────────────────────────────────

function AcPillar({
  report,
  planId,
  onSelect,
}: {
  report: QaReport;
  planId: string;
  onSelect: (item: AcCriterionResult) => void;
}) {
  const { ac } = report;
  const topFails = ac.failures.slice(0, 3);
  const approve = useApproveAc(planId);
  const revoke = useRevokeAcApproval(planId);

  // Subtitle reflects the AC state for this rigor + approval mode.
  const subtitle = ac.manualApproval
    ? `Manually approved · ${relTime(ac.manualApproval.approvedAt)}`
    : report.rigor === 'production'
      ? 'PO-reviewable criteria · production rigor requires sign-off'
      : 'PO-reviewable criteria · done stories auto-pass on mvp';

  return (
    <PillarCard
      title="AC Audit"
      subtitle={subtitle}
      verdict={ac.verdict}
      pass={ac.pass}
      total={ac.total}
      extraValue={ac.pending > 0 ? `${ac.pending} pending` : undefined}
      extraColor="var(--text-mute)"
      onViewAll={topFails.length > 0 ? () => onSelect(topFails[0]) : undefined}
    >
      {ac.total === 0 && (
        <p style={{ color: 'var(--text-mute)', fontSize: 12, margin: 0 }}>
          No acceptance criteria captured yet.
        </p>
      )}
      {topFails.length > 0 && (
        <FailureList
          items={topFails.map((f) => ({
            key: f.criterionId,
            text: f.text,
            context: f.storyId,
            onClick: () => onSelect(f),
          }))}
        />
      )}

      {/* Manual sign-off affordance. Visible only when:
          — at least one pending, no PO job, no existing approval (canManuallyApprove)
          — OR an existing approval we can revoke */}
      {ac.canManuallyApprove && (
        <button
          type="button"
          onClick={() => approve.mutate()}
          disabled={approve.isPending}
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 6,
            fontSize: 10,
            padding: '6px 12px',
            border: '1px solid var(--success)',
            borderRadius: 3,
            background: 'color-mix(in srgb, var(--success) 8%, transparent)',
            color: 'var(--success)',
            fontWeight: 500,
            letterSpacing: '0.12em',
            textTransform: 'uppercase',
            cursor: approve.isPending ? 'not-allowed' : 'pointer',
            alignSelf: 'flex-start',
            marginTop: 4,
            opacity: approve.isPending ? 0.6 : 1,
          }}
        >
          {approve.isPending ? <Loader2 size={11} className="animate-spin" /> : <Check size={11} />}
          Mark AC reviewed
        </button>
      )}
      {ac.manualApproval && (
        <button
          type="button"
          onClick={() => revoke.mutate()}
          disabled={revoke.isPending}
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 6,
            fontSize: 10,
            padding: '4px 10px',
            border: '1px solid var(--border-2)',
            borderRadius: 3,
            background: 'transparent',
            color: 'var(--text-mute)',
            letterSpacing: '0.12em',
            textTransform: 'uppercase',
            cursor: revoke.isPending ? 'not-allowed' : 'pointer',
            alignSelf: 'flex-start',
            marginTop: 4,
            opacity: revoke.isPending ? 0.6 : 1,
          }}
        >
          {revoke.isPending ? <Loader2 size={11} className="animate-spin" /> : <Undo2 size={11} />}
          Undo approval
        </button>
      )}
    </PillarCard>
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

function VqaPillar({
  report,
  onSelect,
}: {
  report: QaReport;
  onSelect: (item: VqaTestResult) => void;
}) {
  const { vqa } = report;
  const topFails = vqa.failures.slice(0, 3);
  return (
    <PillarCard
      title="Visual QA"
      subtitle="Browser behavior matches expectation"
      verdict={vqa.verdict}
      pass={vqa.pass}
      total={vqa.total}
      extraValue={vqa.pending > 0 ? `${vqa.pending} pending` : undefined}
      extraColor="var(--text-mute)"
      onViewAll={topFails.length > 0 ? () => onSelect(topFails[0]) : undefined}
    >
      {vqa.total === 0 &&
        // dragon1 (2026-06-10) — at mvp+ rigor, zero visual tests on a UI
        // app is a PLANNING DEFECT (the PM emitted no needsBrowser ACs, so
        // DEV never authored VISUAL_TESTS), not a benign skip. New plans
        // are gated at apply time (VISUAL_COVERAGE_MISSING); this copy
        // covers plans authored before the gate. Prototype rigor keeps the
        // neutral copy — visual QA is skipped by design there.
        (report.rigor === 'prototype' ? (
          <p style={{ color: 'var(--text-mute)', fontSize: 12, margin: 0 }}>
            No visual tests captured. Dev agent emits them during story work.
          </p>
        ) : report.hasBrowserTests ? (
          // dino1 (2026-06-10) — total===0 with browser tests authored just
          // means QA hasn't executed yet; the old copy wrongly diagnosed
          // "zero needsBrowser ACs" on plans that had them.
          <p style={{ color: 'var(--text-mute)', fontSize: 12, margin: 0, lineHeight: 1.5 }}>
            Visual QA has not executed yet. It runs automatically when development completes
            (aggregate → auto-approved → screenshots). Use Run QA Review to trigger it manually.
          </p>
        ) : (
          <p style={{ color: 'var(--warning)', fontSize: 12, margin: 0, lineHeight: 1.5 }}>
            Coverage gap: this plan was authored with zero needsBrowser ACs, so no story ever
            produced visual tests and there is nothing for visual QA to run. New plans are now
            rejected at apply time for this. To visually verify this app, create a follow-up plan —
            its stories will carry browser ACs and full visual QA will run.
          </p>
        ))}
      {vqa.thumbnails.length > 0 && <ThumbnailStrip thumbs={vqa.thumbnails.slice(0, 4)} />}
      {topFails.length > 0 && (
        <FailureList
          items={topFails.map((f) => ({
            key: f.testId,
            text: f.expected ?? f.testId,
            context: f.storyId,
            onClick: () => onSelect(f),
          }))}
        />
      )}
    </PillarCard>
  );
}

function GatePillar({ report }: { report: QaReport }) {
  const { gate } = report;
  const isSkipped = gate.verdict === 'skipped';
  // QA-D — rows with real stage data count stages; legacy rows count cells.
  const failingRows = gate.waveRows.filter((r) =>
    r.stages && r.stages.length > 0
      ? r.stages.some((s) => s.status === 'fail')
      : Object.values(r.cells).some((c) => c === 'fail'),
  ).length;
  const totalCells = gate.waveRows.reduce(
    (n, r) => n + (r.stages && r.stages.length > 0 ? r.stages.length : gate.activeChecks.length),
    0,
  );
  const passCells = gate.waveRows.reduce(
    (n, r) =>
      n +
      (r.stages && r.stages.length > 0
        ? r.stages.filter((s) => s.status === 'pass').length
        : Object.values(r.cells).filter((c) => c === 'pass').length),
    0,
  );
  const subtitle = isSkipped
    ? 'Rigor=prototype — no automated gate runs.'
    : gate.hasStageData
      ? 'Per-wave real stage outcomes (wave-merge gate)'
      : `Per-wave ${gate.activeChecks.length} checks: ${gate.activeChecks.join(' · ')}`;
  return (
    <PillarCard
      title="Automated Gate"
      subtitle={subtitle}
      verdict={gate.verdict}
      pass={passCells}
      total={totalCells}
      extraValue={
        failingRows > 0 ? `${failingRows} wave${failingRows === 1 ? '' : 's'} failing` : undefined
      }
      extraColor="var(--destructive)"
      onViewAll={!isSkipped ? () => console.info('[QA] Build matrix TODO') : undefined}
    >
      {isSkipped && (
        <p style={{ color: 'var(--text-mute)', fontSize: 12, margin: 0 }}>
          Promote this plan to <code>mvp</code> or <code>production</code> rigor to enable the
          automated test gate.
        </p>
      )}
      {!isSkipped && gate.waveRows.length === 0 && (
        <p style={{ color: 'var(--text-mute)', fontSize: 12, margin: 0 }}>
          No waves yet — the gate surfaces once dev waves produce build-check jobs.
        </p>
      )}
      {!isSkipped && Object.keys(gate.tamperCountsByStory).length > 0 && (
        <TamperSummary counts={gate.tamperCountsByStory} />
      )}
    </PillarCard>
  );
}

// ── Bits ────────────────────────────────────────────────────────────

function FailureList({
  items,
}: {
  items: Array<{ key: string; text: string; context: string; onClick?: () => void }>;
}) {
  return (
    <ul
      style={{
        listStyle: 'none',
        padding: 0,
        margin: 0,
        display: 'flex',
        flexDirection: 'column',
        gap: 0,
      }}
    >
      {items.map((i) => (
        <li key={i.key}>
          <button
            type="button"
            onClick={i.onClick}
            disabled={!i.onClick}
            style={{
              width: '100%',
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              padding: '6px 4px',
              borderTop: '1px solid var(--border)',
              fontSize: 12,
              background: 'transparent',
              border: 'none',
              borderTopStyle: 'solid',
              cursor: i.onClick ? 'pointer' : 'default',
              textAlign: 'left',
              color: 'var(--text-dim)',
              transition: 'background 120ms',
            }}
            onMouseEnter={(e) => {
              if (i.onClick)
                e.currentTarget.style.background =
                  'color-mix(in srgb, var(--foreground) 3%, transparent)';
            }}
            onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
          >
            <span
              style={{
                background: 'var(--destructive)',
                width: 5,
                height: 5,
                borderRadius: '50%',
                flexShrink: 0,
                display: 'inline-block',
              }}
            />
            <span
              style={{
                fontFamily: 'var(--font-mono)',
                fontSize: 9,
                color: 'var(--text-faint)',
                letterSpacing: '0.08em',
                flexShrink: 0,
              }}
            >
              {i.key}
            </span>
            <span
              style={{
                flex: 1,
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              }}
            >
              {i.text}
            </span>
          </button>
        </li>
      ))}
    </ul>
  );
}

function ThumbnailStrip({ thumbs }: { thumbs: VqaTestResult[] }) {
  return (
    <div style={{ display: 'flex', gap: 6 }}>
      {thumbs.map((t) => {
        const border =
          t.status === 'pending'
            ? 'var(--warning)'
            : t.status === 'pass'
              ? 'var(--success)'
              : 'var(--destructive)';
        return (
          <div
            key={t.testId}
            title={`${t.testId} · ${t.status}`}
            style={{
              width: 54,
              height: 36,
              border: `1px solid ${border}`,
              borderRadius: 3,
              background: 'var(--surface)',
              overflow: 'hidden',
              position: 'relative',
              flexShrink: 0,
            }}
          >
            {t.screenshotUrl ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={t.screenshotUrl}
                alt={t.testId}
                style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }}
                onError={(e) => {
                  (e.currentTarget as HTMLImageElement).style.display = 'none';
                }}
              />
            ) : (
              <div
                style={{
                  position: 'absolute',
                  inset: 0,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  fontFamily: 'var(--font-mono)',
                  fontSize: 8,
                  color: 'var(--text-faint)',
                  textTransform: 'uppercase',
                  letterSpacing: '0.1em',
                }}
              >
                {t.testId}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

function TamperSummary({ counts }: { counts: Record<string, number> }) {
  const flagged = Object.entries(counts).filter(([, n]) => n > 0);
  if (flagged.length === 0) return null;
  return (
    <div
      style={{
        fontFamily: 'var(--font-mono)',
        fontSize: 10,
        color: 'var(--warning)',
        letterSpacing: '0.06em',
      }}
    >
      ⚠ Tamper reverts · {flagged.length} {flagged.length === 1 ? 'story' : 'stories'}
    </div>
  );
}

function AttentionBanner({ count }: { count: number }) {
  // Ported to the in-hero bell; we just hint to the user it's there.
  return (
    <div
      style={{
        padding: '10px 14px',
        border: '1px solid var(--border)',
        borderRadius: 6,
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

// Unused silencing — Wave 2 will wire these to the drawer.
void ({} as AcCriterionResult);

/**
 * Running banner — shown when qa-execute is in flight (or queued for the
 * daemon). PR-8a moved QA to plan-scope, so the old per-epic check
 * (`e.qaVerdict === 'pending' && !!e.qaJobId`) never fires for current
 * plans — epic.qaJobId is unused. Re-derive from `vqa.executeStatus`.
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
        borderRadius: 6,
        display: 'flex',
        alignItems: 'center',
        gap: 12,
        fontFamily: 'var(--font-mono)',
        fontSize: 12,
      }}
    >
      <Loader2 size={14} className="animate-spin" style={{ color: 'var(--accent-purple)' }} />
      <span style={{ color: 'var(--foreground)', fontWeight: 500, letterSpacing: '0.02em' }}>
        {label}
      </span>
      <span style={{ color: 'var(--text-mute)', letterSpacing: '0.06em' }}>
        {status === 'queued-execute'
          ? 'Daemon will pick up the execute job within ~60s.'
          : 'Capturing screenshots + judging tests · scroll to Visual QA Logs for live output'}
      </span>
    </div>
  );
}
