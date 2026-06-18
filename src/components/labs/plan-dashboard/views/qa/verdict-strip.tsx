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

import { useQueryClient } from '@tanstack/react-query';
import { Loader2, RefreshCw, ArrowRight, Send, Rocket, ExternalLink } from 'lucide-react';
import { useRouter, useSearchParams } from 'next/navigation';
import type { QaReport, PlanQaVerdict, QaPillarVerdict, DevPreview } from '@/types/qa-report';
import { useRunQaReview, useSendBackFailing } from '@/hooks/use-qa-report';
import { useDeployApp } from '@/hooks/use-epic-workflow';
import { DeployLogs } from '../deploy/deploy-logs';

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
        // QA-C honesty: below production rigor, done stories auto-pass their
        // ACs without explicit PO/operator sign-off. Label the rubber stamp
        // as what it is instead of presenting it like real verification.
        note={
          report.rigor !== 'production' && !report.ac.manualApproval && report.ac.pass > 0
            ? `auto-pass (${report.rigor})`
            : undefined
        }
      />
      <MiniGauge
        label="VQA"
        verdict={report.vqa.verdict}
        pass={report.vqa.pass}
        total={report.vqa.total}
      />
      {/* QA-B — the wave-gate VQA arc: judged verdicts on the MERGED
          candidate, the strongest evidence the pipeline produces. */}
      {report.gateVqa && <GateVqaChip rollup={report.gateVqa} />}
      <MiniGauge
        label="Gate"
        verdict={report.gate.verdict}
        // QA-D — when waves carry real per-stage outcomes, count those; the
        // legacy rows×checks product painted N cells from one bit.
        pass={countGatePass(report)}
        total={countGateTotal(report)}
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
        <DevPreviewControls preview={report.devPreview} planId={planId} />
        <RunQaButton report={report} runQa={runQa} onClick={onRunQa} />
        <button
          type="button"
          onClick={onPromote}
          disabled={!ready}
          aria-label={ready ? 'Go to the Deploy stage' : 'Deploy stage not yet available'}
          title={
            ready ? 'Open the Deploy stage' : (report.blockingReason ?? 'Waiting for QA verdict')
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
          Go to Deploy
          <ArrowRight size={10} aria-hidden="true" />
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

/**
 * Deployment v2.5 — dev-preview controls.
 *
 * The whole point of this cluster: let the operator click and exercise the
 * EXACT merged build that headless QA is testing against. The dev deploy is
 * auto-triggered when the plan reaches `review`, so the common case is the
 * "Open in dev" link simply being present. The button lets the operator
 * (re-)publish on demand. Dev deploys never advance `main`.
 */
function DevPreviewControls({ preview, planId }: { preview: DevPreview; planId: string }) {
  const deploy = useDeployApp();
  const qc = useQueryClient();
  const { epicId, url, status, jobId } = preview;

  function onDeployDev() {
    if (!epicId || deploy.isPending) return;
    deploy.mutate(
      { epicId, environment: 'dev' },
      { onSuccess: () => qc.invalidateQueries({ queryKey: ['qa-report', planId] }) },
    );
  }

  // A4 — optimistic pending: deploy.isPending flips immediately on click,
  // before the qa-report poll flips status to 'deploying'. Either signal
  // means a dev deploy is in flight.
  const deploying = status === 'deploying' || deploy.isPending;

  // A4 — surface a failed enqueue/deploy mutation inline. Currently there is
  // NO error surface on this control, so a 400 looked like a no-op click.
  const deployErr = deploy.isError
    ? deploy.error instanceof Error
      ? deploy.error.message
      : String(deploy.error)
    : null;

  return (
    <span
      style={{
        display: 'inline-flex',
        flexDirection: 'column',
        alignItems: 'flex-end',
        gap: 6,
      }}
    >
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
        {/* A1 reliance — `url` is `preview.url` verbatim. With the
            build-deploy-pipeline DEPLOY_URL regex fix (underscore no longer
            truncates), plan.devUrl is now the FULL `…/apps/_dev/<app>/` URL,
            so this link finally points at the real dev build. */}
        {url && status === 'live' && (
          <a
            href={url}
            target="_blank"
            rel="noopener noreferrer"
            aria-label="Open the dev preview in a new tab"
            title="Open the dev preview — the same merged build QA is testing, clickable by you"
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 6,
              fontSize: 10,
              letterSpacing: '0.14em',
              textTransform: 'uppercase',
              padding: '7px 14px',
              border: '1px solid var(--accent-blue)',
              borderRadius: 2,
              color: 'var(--accent-blue)',
              background: 'color-mix(in srgb, var(--accent-blue) 10%, transparent)',
              fontWeight: 500,
              textDecoration: 'none',
            }}
          >
            Open in dev
            <ExternalLink size={10} aria-hidden="true" />
          </a>
        )}
        {(epicId || status === 'failed') && (
          <button
            type="button"
            onClick={onDeployDev}
            disabled={!epicId || deploying}
            aria-label={
              deploying
                ? 'Dev deploy in progress'
                : status === 'failed'
                  ? 'Retry dev deploy'
                  : status === 'live'
                    ? 'Re-deploy to dev preview'
                    : 'Deploy to dev preview'
            }
            title={
              !epicId
                ? 'No epics to deploy yet'
                : status === 'failed'
                  ? 'The last dev deploy failed — retry'
                  : status === 'live'
                    ? 'Re-publish the current build to the dev preview'
                    : 'Publish the current build to the dev preview'
            }
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 6,
              fontSize: 10,
              letterSpacing: '0.14em',
              textTransform: 'uppercase',
              padding: '7px 14px',
              border: `1px solid ${status === 'failed' ? 'var(--destructive)' : 'var(--border-2)'}`,
              borderRadius: 2,
              color: status === 'failed' ? 'var(--destructive)' : 'var(--text-dim)',
              background: 'transparent',
              cursor: !epicId || deploying ? 'not-allowed' : 'pointer',
              opacity: !epicId || deploying ? 0.5 : 1,
            }}
          >
            {deploying ? (
              <Loader2 size={10} className="animate-spin" aria-hidden="true" />
            ) : (
              <Rocket size={10} aria-hidden="true" />
            )}
            {deploying
              ? 'Dev deploying…'
              : status === 'failed'
                ? 'Retry dev'
                : status === 'live'
                  ? 'Re-deploy dev'
                  : 'Deploy to dev'}
          </button>
        )}
      </span>

      {/* A4 — inline deploy-error banner. role="alert" so a screen reader
          announces the failure reason that was previously silent. */}
      {deployErr && (
        <span
          role="alert"
          style={{
            display: 'inline-flex',
            alignItems: 'flex-start',
            gap: 6,
            fontFamily: 'var(--font-mono)',
            fontSize: 10,
            color: 'var(--destructive)',
            background: 'color-mix(in srgb, var(--destructive) 10%, transparent)',
            border: '1px solid var(--destructive)',
            borderRadius: 2,
            padding: '6px 8px',
            maxWidth: 280,
            textAlign: 'left',
            lineHeight: 1.4,
            overflowWrap: 'anywhere',
          }}
        >
          {deployErr}
        </span>
      )}

      {/* A3 — compact streaming progress/logs for the in-flight dev deploy.
          Reuse DeployLogs with the dev job FK (BE-2 populates
          devPreview.jobId = plan.devDeployJobId). Guard on `deploying` so a
          stale jobId from a finished deploy doesn't keep streaming. */}
      {deploying && jobId && (
        <div style={{ width: 360, maxWidth: '100%' }}>
          <DeployLogs deployJobId={jobId} />
        </div>
      )}
    </span>
  );
}

// ── Helpers ──────────────────────────────────────────────────────────

// QA-D — rows with real stage data count stages; legacy rows count cells.
function countGatePass(report: QaReport): number {
  let n = 0;
  for (const row of report.gate.waveRows) {
    if (row.stages && row.stages.length > 0) {
      n += row.stages.filter((s) => s.status === 'pass').length;
    } else {
      for (const cell of Object.values(row.cells)) {
        if (cell === 'pass') n += 1;
      }
    }
  }
  return n;
}

function countGateTotal(report: QaReport): number {
  let n = 0;
  for (const row of report.gate.waveRows) {
    n += row.stages && row.stages.length > 0 ? row.stages.length : report.gate.activeChecks.length;
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
  note,
}: {
  label: string;
  verdict: QaPillarVerdict;
  pass: number;
  total: number;
  /** QA-C — honesty annotation rendered after the value (e.g. "auto-pass (mvp)"). */
  note?: string;
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
        {note && (
          <span
            title="Below production rigor the AC audit auto-passes when a story completes — this is a recorded assumption, not an explicit verification."
            style={{
              fontFamily: 'var(--font-mono)',
              fontSize: 8,
              color: 'var(--warning)',
              letterSpacing: '0.08em',
              textTransform: 'uppercase',
            }}
          >
            {note}
          </span>
        )}
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

/**
 * QA-B — the wave-gate VQA summary chip: `gate-VQA 5✓ · 1 fixed` (verified +
 * fixed counts), warning-colored while any fix-forward is still open.
 */
function GateVqaChip({ rollup }: { rollup: NonNullable<QaReport['gateVqa']> }) {
  const good = rollup.verified + rollup.fixedInGate + rollup.fixedByStory;
  const open = rollup.fixForwarded;
  const color = open > 0 ? 'var(--warning)' : good > 0 ? 'var(--success)' : 'var(--text-mute)';
  const fixed = rollup.fixedInGate + rollup.fixedByStory;
  const parts = [
    `${good}✓`,
    fixed > 0 ? `${fixed} fixed` : null,
    open > 0 ? `${open} open` : null,
    rollup.unverifiable > 0 ? `${rollup.unverifiable} unverifiable` : null,
  ].filter(Boolean);
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
          Gate-VQA
        </span>
        <span
          title="Judged visual verdicts on each wave's MERGED candidate (v2.6 wave gate) — verified / fixed in gate / fixed by auto-minted story / still-open fix-forwards"
          style={{
            fontFamily: 'var(--font-mono)',
            fontSize: 13,
            color,
            fontWeight: 500,
            letterSpacing: '0.01em',
            whiteSpace: 'nowrap',
          }}
        >
          {parts.join(' · ')}
        </span>
      </div>
      <div style={{ width: 80, height: 2, background: 'var(--border)', overflow: 'hidden' }}>
        <div
          style={{
            width: `${rollup.claims.length > 0 ? Math.round((good / rollup.claims.length) * 100) : 0}%`,
            height: '100%',
            background: color,
            opacity: 0.9,
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
