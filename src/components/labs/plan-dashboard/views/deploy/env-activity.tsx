'use client';

/**
 * Environment activity — persistent, per-environment deploy logs.
 *
 * Deployment v2.5 (deployment session, 2026-06-18). Replaces the single shared
 * DeployLogs/DeploySteps panel that was pinned to a sticky manually-selected
 * job (so after a production promote it kept showing the staging job, and logs
 * "disappeared" when the active job changed).
 *
 * Each environment that has ever deployed gets its OWN collapsible card with
 * status + smoke + timing + an embedded live/streamed log, keyed to that env's
 * durable `activeJobId` (plan.devDeployJobId / stagingDeployJobId / last prod
 * deployJobId). The card persists after completion (events live in the DB) and
 * never depends on a transient selection. The env currently deploying — and the
 * most-recent one — auto-expand so you watch the live stream and review the last
 * result without a click; anything else is one disclosure-toggle away.
 */

import { useMemo, useState } from 'react';
import { ChevronRight, ExternalLink, CheckCircle, AlertTriangle, Loader2 } from 'lucide-react';
import type { DeployEnvironmentStatus, DeployEnvironmentName } from '@/types/deploy-report';
import { DeployLogs } from './deploy-logs';

const ENV_LABEL: Record<DeployEnvironmentName, string> = {
  dev: 'Dev',
  staging: 'Staging',
  production: 'Production',
};

const STATUS_META: Record<DeployEnvironmentStatus['status'], { label: string; color: string }> = {
  none: { label: 'not deployed', color: 'var(--text-mute)' },
  deploying: { label: 'deploying', color: 'var(--accent-purple)' },
  live: { label: 'live', color: 'var(--success)' },
  failed: { label: 'failed', color: 'var(--destructive)' },
};

export function EnvActivity({ environments }: { environments: DeployEnvironmentStatus[] }) {
  // Only environments that have actually run a deploy have a streamable job.
  const cards = useMemo(
    () =>
      environments
        .filter((e) => !!e.activeJobId)
        .slice()
        // Most-recent first (deploying always floats to the top), so the latest
        // action — e.g. the production promote you just ran — is front-and-center.
        .sort((a, b) => {
          if (a.status === 'deploying' && b.status !== 'deploying') return -1;
          if (b.status === 'deploying' && a.status !== 'deploying') return 1;
          return (b.deployedAt ?? '').localeCompare(a.deployedAt ?? '');
        }),
    [environments],
  );

  // Explicit user open/close overrides (env → bool). Default open-state is
  // DERIVED at render (no setState-in-effect): the deploying env and the
  // most-recent env are open by default so you watch the live stream and review
  // the last result; an explicit toggle wins thereafter.
  const [overrides, setOverrides] = useState<Partial<Record<DeployEnvironmentName, boolean>>>({});
  const mostRecent = cards[0]?.environment;

  if (cards.length === 0) return null;

  const isOpen = (env: DeployEnvironmentStatus): boolean =>
    overrides[env.environment] ?? (env.status === 'deploying' || env.environment === mostRecent);

  function toggle(env: DeployEnvironmentStatus) {
    setOverrides((prev) => ({ ...prev, [env.environment]: !isOpen(env) }));
  }

  return (
    <section
      aria-label="Deploy activity"
      style={{
        border: '1px solid var(--border)',
        borderRadius: 10,
        background: 'var(--bg-elev)',
        overflow: 'hidden',
      }}
    >
      <header
        style={{
          padding: '12px 18px',
          borderBottom: '1px solid var(--border)',
          fontFamily: 'var(--font-mono)',
          fontSize: 9,
          letterSpacing: '0.22em',
          textTransform: 'uppercase',
          color: 'var(--text-faint)',
        }}
      >
        Deploy activity · per-environment logs (persist across deploys)
      </header>

      <ul style={{ listStyle: 'none', margin: 0, padding: 0 }}>
        {cards.map((env, i) => (
          <EnvCard
            key={env.environment}
            env={env}
            open={isOpen(env)}
            onToggle={() => toggle(env)}
            divider={i > 0}
          />
        ))}
      </ul>
    </section>
  );
}

function EnvCard({
  env,
  open,
  onToggle,
  divider,
}: {
  env: DeployEnvironmentStatus;
  open: boolean;
  onToggle: () => void;
  divider: boolean;
}) {
  const meta = STATUS_META[env.status];
  const label = ENV_LABEL[env.environment];
  const regionId = `env-logs-${env.environment}`;

  return (
    <li style={{ borderTop: divider ? '1px solid var(--border)' : 'none' }}>
      {/* Header row — entire row toggles the disclosure */}
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        aria-controls={regionId}
        style={{
          width: '100%',
          display: 'flex',
          alignItems: 'center',
          gap: 12,
          padding: '12px 18px',
          background: 'transparent',
          border: 'none',
          cursor: 'pointer',
          textAlign: 'left',
        }}
      >
        <ChevronRight
          size={14}
          aria-hidden="true"
          style={{
            color: 'var(--text-mute)',
            flexShrink: 0,
            transform: open ? 'rotate(90deg)' : 'none',
            transition: 'transform 120ms',
          }}
        />
        <span
          className={env.status === 'deploying' ? 'animate-pulse-soft' : ''}
          style={{
            width: 8,
            height: 8,
            borderRadius: '50%',
            background: meta.color,
            flexShrink: 0,
          }}
        />
        <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--foreground)', minWidth: 84 }}>
          {label}
        </span>
        <span
          style={{
            fontFamily: 'var(--font-mono)',
            fontSize: 9,
            letterSpacing: '0.14em',
            textTransform: 'uppercase',
            color: meta.color,
          }}
        >
          {env.status === 'deploying' && (
            <Loader2
              size={9}
              className="animate-spin"
              aria-hidden="true"
              style={{ marginRight: 4, verticalAlign: 'middle' }}
            />
          )}
          {meta.label}
        </span>

        {env.smokeStatus && <SmokeChip status={env.smokeStatus} detail={env.smokeDetail} />}

        {/* Right-aligned meta */}
        <span
          style={{
            marginLeft: 'auto',
            display: 'inline-flex',
            alignItems: 'center',
            gap: 12,
            fontFamily: 'var(--font-mono)',
            fontSize: 10,
            color: 'var(--text-mute)',
          }}
        >
          {env.activeJobId && (
            <span title={`job ${env.activeJobId}`}>job {env.activeJobId.slice(0, 8)}</span>
          )}
          {env.durationSec != null && <span>{fmtDuration(env.durationSec)}</span>}
          {env.deployedAt && <span>{relTime(env.deployedAt)}</span>}
        </span>
      </button>

      {/* Open-link row (kept out of the toggle button so it's independently clickable) */}
      {env.url && env.status === 'live' && (
        <div style={{ padding: '0 18px 8px 44px', marginTop: -6 }}>
          <a
            href={env.url}
            target="_blank"
            rel="noopener noreferrer"
            style={{
              fontFamily: 'var(--font-mono)',
              fontSize: 10,
              color: 'var(--accent-blue)',
              textDecoration: 'none',
              display: 'inline-flex',
              alignItems: 'center',
              gap: 4,
            }}
          >
            {env.url.replace('https://', '')}
            <ExternalLink size={9} aria-hidden="true" />
          </a>
        </div>
      )}

      {/* Disclosure body */}
      {open && (
        <div id={regionId} style={{ padding: '0 18px 16px 44px' }}>
          {env.smokeStatus === 'fail' && <SmokeBanner env={env} />}
          <DeployLogs deployJobId={env.activeJobId ?? null} />
        </div>
      )}
    </li>
  );
}

/** Compact smoke result chip in the header. */
function SmokeChip({ status, detail }: { status: 'pass' | 'fail'; detail?: string }) {
  const pass = status === 'pass';
  const color = pass ? 'var(--success)' : 'var(--warning)';
  return (
    <span
      title={detail || (pass ? 'Smoke test passed' : 'Smoke test did not pass')}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 4,
        fontFamily: 'var(--font-mono)',
        fontSize: 9,
        letterSpacing: '0.1em',
        textTransform: 'uppercase',
        color,
      }}
    >
      {pass ? (
        <CheckCircle size={10} aria-hidden="true" />
      ) : (
        <AlertTriangle size={10} aria-hidden="true" />
      )}
      {pass ? 'smoke' : 'smoke failed'}
    </span>
  );
}

/**
 * Honest smoke-failure banner. A 403/origin/CDN failure (bundle present in S3)
 * is an ENVIRONMENT problem, not a bad build — say so, don't blame the artifact.
 */
function SmokeBanner({ env }: { env: DeployEnvironmentStatus }) {
  const infra = env.smokeInfra;
  return (
    <div
      role="status"
      style={{
        display: 'flex',
        gap: 8,
        alignItems: 'flex-start',
        padding: '10px 12px',
        margin: '0 0 10px',
        border: `1px solid ${infra ? 'var(--warning)' : 'var(--border-2)'}`,
        borderRadius: 6,
        background: 'color-mix(in srgb, var(--warning) 7%, transparent)',
      }}
    >
      <AlertTriangle
        size={13}
        aria-hidden="true"
        style={{ color: 'var(--warning)', flexShrink: 0, marginTop: 1 }}
      />
      <div style={{ fontSize: 11.5, lineHeight: 1.5, color: 'var(--text-dim)' }}>
        <strong style={{ color: 'var(--warning)' }}>
          {infra ? 'Environment unreachable — not a build problem.' : 'Smoke check did not pass.'}
        </strong>{' '}
        {infra
          ? 'The bundle is published to S3, but the live URL returned an origin/CDN error (e.g. 403 / AccessDenied). Fix the CloudFront → S3 access (OAC / bucket policy) for this environment; the artifact itself is fine.'
          : 'The deploy synced, but the live URL did not return a healthy page. Review the log below before promoting.'}
        {env.smokeDetail && (
          <span
            style={{
              display: 'block',
              marginTop: 5,
              fontFamily: 'var(--font-mono)',
              fontSize: 10,
              color: 'var(--text-mute)',
            }}
          >
            {env.smokeDetail}
          </span>
        )}
      </div>
    </div>
  );
}

function fmtDuration(s: number): string {
  if (!Number.isFinite(s)) return '—';
  if (s < 60) return `${Math.round(s)}s`;
  const m = Math.floor(s / 60);
  return `${m}m ${Math.round(s % 60)}s`;
}

function relTime(iso: string): string {
  const ms = Date.now() - Date.parse(iso);
  if (!Number.isFinite(ms)) return '';
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}
