'use client';

/**
 * Release strip — sticky top of the Deploy pipeline stage. Analogous to the
 * QA Review verdict strip: big status pill, target URL, primary Deploy CTA.
 */

import { useMemo } from 'react';
import { Loader2, Rocket, RefreshCw, ArrowRight, Copy, ExternalLink } from 'lucide-react';
import type { DeployReport, DeployVerdict } from '@/types/deploy-report';
import { useDeployApp } from '@/hooks/use-epic-workflow';

interface Props {
  report: DeployReport;
  /** Target epic id for the `useDeployApp` mutation. */
  epicId: string | null;
  /** Disabled when the QA report isn't ready + no previous deploy. */
  canDeploy: boolean;
  /** Tooltip shown on the deploy button when disabled. */
  blockedReason?: string;
}

const META: Record<DeployVerdict, { label: string; color: string; pulse: boolean }> = {
  ready: { label: 'Ready to ship', color: 'var(--success)', pulse: false },
  deploying: { label: 'Deploying', color: 'var(--accent-purple)', pulse: true },
  live: { label: 'Live', color: 'var(--success)', pulse: false },
  failed: { label: 'Deploy failed', color: 'var(--destructive)', pulse: false },
  'not-ready': { label: 'Not ready', color: 'var(--warning)', pulse: false },
  'never-deployed': { label: 'Never deployed', color: 'var(--text-mute)', pulse: false },
};

export function ReleaseStrip({ report, epicId, canDeploy, blockedReason }: Props) {
  const deploy = useDeployApp();
  const meta = META[report.verdict];
  const deploying = report.verdict === 'deploying';
  const canAct = canDeploy && epicId && !deploying && !deploy.isPending;

  const current = report.current;
  const lastDeploy = useMemo(() => {
    if (!current) return null;
    return { ago: relTime(current.finishedAtIso ?? current.startedAtIso), jobId: current.jobId };
  }, [current]);

  function onDeploy() {
    if (!canAct || !epicId) return;
    deploy.mutate({ epicId, environment: 'production' });
  }

  const ctaLabel = deploying
    ? 'Deploying…'
    : deploy.isPending
      ? 'Enqueueing…'
      : report.verdict === 'live' || report.verdict === 'failed'
        ? 'Re-deploy'
        : 'Deploy to production';

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
          className={meta.pulse ? 'animate-pulse-soft' : ''}
          style={{
            background: meta.color,
            width: 8,
            height: 8,
            borderRadius: '50%',
            display: 'inline-block',
            boxShadow: meta.pulse ? `0 0 10px ${meta.color}` : 'none',
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

      {/* Target URL */}
      <div style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
        <span
          style={{
            fontFamily: 'var(--font-mono)',
            fontSize: 8,
            color: 'var(--text-faint)',
            textTransform: 'uppercase',
            letterSpacing: '0.22em',
          }}
        >
          Target
        </span>
        <a
          href={report.target.publicUrl}
          target="_blank"
          rel="noopener noreferrer"
          style={{
            fontFamily: 'var(--font-mono)',
            fontSize: 12,
            color: 'var(--text-dim)',
            textDecoration: 'none',
            letterSpacing: '0.02em',
            borderBottom: '1px dashed var(--border-2)',
            paddingBottom: 1,
          }}
        >
          {report.target.publicUrl.replace('https://', '')}
          <ExternalLink size={10} style={{ marginLeft: 4, verticalAlign: 'middle' }} />
        </a>
        <button
          type="button"
          onClick={() => navigator.clipboard.writeText(report.target.publicUrl)}
          style={{
            background: 'transparent',
            border: 'none',
            color: 'var(--text-mute)',
            cursor: 'pointer',
            padding: 2,
          }}
          aria-label="Copy URL"
        >
          <Copy size={11} />
        </button>
      </div>

      {/* Last deploy timestamp */}
      {lastDeploy && (
        <span
          style={{
            fontFamily: 'var(--font-mono)',
            fontSize: 10,
            color: 'var(--text-mute)',
            letterSpacing: '0.06em',
          }}
        >
          Last · {lastDeploy.ago}
        </span>
      )}

      {/* Reason (when not ready / failed) */}
      {report.statusReason && (
        <span
          style={{
            fontFamily: 'var(--font-mono)',
            fontSize: 10,
            color: 'var(--warning)',
            letterSpacing: '0.04em',
            maxWidth: 400,
          }}
        >
          {report.statusReason}
        </span>
      )}

      {/* CTAs */}
      <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 10 }}>
        {report.verdict === 'failed' && report.current && (
          <button type="button" onClick={onDeploy} disabled={!canAct} style={ghostCta(!canAct)}>
            <RefreshCw size={11} />
            Retry deploy
          </button>
        )}
        {report.verdict === 'live' && report.current?.publicUrl && (
          <a
            href={report.current.publicUrl}
            target="_blank"
            rel="noopener noreferrer"
            style={{ ...ghostCta(false), textDecoration: 'none' }}
          >
            Open live
            <ArrowRight size={11} />
          </a>
        )}
        <button
          type="button"
          onClick={onDeploy}
          disabled={!canAct}
          title={!canAct ? blockedReason || 'Deploy not available' : undefined}
          style={primaryCta(!canAct, report.verdict)}
        >
          {deploying || deploy.isPending ? (
            <Loader2 size={11} className="animate-spin" />
          ) : (
            <Rocket size={11} />
          )}
          {ctaLabel}
        </button>
      </div>
    </div>
  );
}

function primaryCta(disabled: boolean, verdict: DeployVerdict): React.CSSProperties {
  const go =
    verdict === 'ready' ||
    verdict === 'never-deployed' ||
    verdict === 'live' ||
    verdict === 'failed';
  return {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 6,
    fontSize: 10,
    letterSpacing: '0.14em',
    textTransform: 'uppercase',
    padding: '7px 14px',
    border: go ? '1px solid var(--success)' : '1px solid var(--border-2)',
    borderRadius: 2,
    color: go ? 'var(--background)' : 'var(--text-faint)',
    background: go ? 'var(--success)' : 'transparent',
    fontWeight: 500,
    cursor: disabled ? 'not-allowed' : 'pointer',
    opacity: disabled ? 0.5 : 1,
  };
}

function ghostCta(disabled: boolean): React.CSSProperties {
  return {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 6,
    fontSize: 10,
    letterSpacing: '0.14em',
    textTransform: 'uppercase',
    padding: '7px 14px',
    border: '1px solid var(--border-2)',
    borderRadius: 2,
    color: 'var(--text-dim)',
    background: 'transparent',
    cursor: disabled ? 'not-allowed' : 'pointer',
    opacity: disabled ? 0.5 : 1,
  };
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
