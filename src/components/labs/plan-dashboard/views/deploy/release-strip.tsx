'use client';

/**
 * Release strip — sticky top of the Deploy pipeline stage. Analogous to the
 * QA Review verdict strip: big status pill, target URL, primary CTA.
 *
 * Deployment v2.5 §B1/B4 — the primary CTA advances the promotion ladder
 * (build-once, promote-many) via usePromoteApp; it is NEVER a staging-bypassing
 * fresh production build. A force-rebuild-to-prod escape hatch survives only as
 * a clearly-labelled, warning-gated secondary action. The verdict pill reflects
 * the furthest LIVE rung from report.environments, not the production-only
 * verdict (so "Staging live · production pending" instead of "Never deployed").
 */

import { useMemo, useState } from 'react';
import {
  Loader2,
  Rocket,
  RefreshCw,
  ArrowRight,
  Copy,
  ExternalLink,
  AlertTriangle,
} from 'lucide-react';
import type {
  DeployReport,
  DeployVerdict,
  DeployEnvironmentStatus,
  DeployEnvironmentName,
} from '@/types/deploy-report';
import { useDeployApp } from '@/hooks/use-epic-workflow';
import { usePromoteApp } from '@/hooks/use-deploy-report';

interface Props {
  report: DeployReport;
  /** Target epic id for the force-rebuild escape hatch (`useDeployApp`). */
  epicId: string | null;
  /** Disabled when the QA report isn't ready + no previous deploy. */
  canDeploy: boolean;
  /** Tooltip shown on the primary CTA when disabled. */
  blockedReason?: string;
  /** NEW (v2.5 B1) — enables the ladder-advance primary CTA via usePromoteApp. */
  planId: string;
}

const META: Record<DeployVerdict, { label: string; color: string; pulse: boolean }> = {
  ready: { label: 'Ready to ship', color: 'var(--success)', pulse: false },
  deploying: { label: 'Deploying', color: 'var(--accent-purple)', pulse: true },
  live: { label: 'Live', color: 'var(--success)', pulse: false },
  failed: { label: 'Deploy failed', color: 'var(--destructive)', pulse: false },
  'not-ready': { label: 'Not ready', color: 'var(--warning)', pulse: false },
  'never-deployed': { label: 'Never deployed', color: 'var(--text-mute)', pulse: false },
};

const ENV_ORDER: DeployEnvironmentName[] = ['production', 'staging', 'dev'];
const ENV_LABEL: Record<DeployEnvironmentName, string> = {
  dev: 'Dev',
  staging: 'Staging',
  production: 'Production',
};

function envOf(
  environments: DeployEnvironmentStatus[],
  name: DeployEnvironmentName,
): DeployEnvironmentStatus | undefined {
  return environments.find((e) => e.environment === name);
}

/**
 * B4 — derive the furthest-live-rung summary. Returns a pill label + color that
 * reflects the highest rung actually live (or mid-deploy), overriding the
 * production-only verdict. Falls back to the verdict META when nothing is live.
 */
function deriveVerdictPill(report: DeployReport): {
  label: string;
  color: string;
  pulse: boolean;
} {
  const envs = report.environments ?? [];
  const meta = META[report.verdict];

  // Mid-deploy takes precedence so the pulse + "deploying" stays honest.
  const deployingEnv = ENV_ORDER.map((n) => envOf(envs, n)).find((e) => e?.status === 'deploying');
  if (deployingEnv) {
    return {
      label: `${ENV_LABEL[deployingEnv.environment]} deploying`,
      color: 'var(--accent-purple)',
      pulse: true,
    };
  }

  const prod = envOf(envs, 'production');
  const staging = envOf(envs, 'staging');
  const dev = envOf(envs, 'dev');

  if (prod?.status === 'live') {
    return { label: 'Production live', color: 'var(--success)', pulse: false };
  }
  if (staging?.status === 'live') {
    return { label: 'Staging live · production pending', color: 'var(--success)', pulse: false };
  }
  if (dev?.status === 'live') {
    return { label: 'Dev live · staging pending', color: 'var(--accent-blue)', pulse: false };
  }

  // Nothing live — keep the existing verdict label/color (failed / not-ready / never-deployed).
  return { label: meta.label, color: meta.color, pulse: meta.pulse };
}

/**
 * B1 — determine the next ladder action from report.environments.
 *  - dev live, staging not live      → promote to staging
 *  - staging live, production not live → promote to production (typed confirm)
 *  - production live                  → re-promote to production
 *  - otherwise                        → no ladder action (gated upstream)
 */
function nextLadderAction(report: DeployReport): {
  to: 'staging' | 'production';
  label: string;
  confirm: boolean;
} | null {
  const envs = report.environments ?? [];
  const dev = envOf(envs, 'dev');
  const staging = envOf(envs, 'staging');
  const prod = envOf(envs, 'production');

  if (prod?.status === 'live') {
    // Re-promote only makes sense when a staging artifact still exists to copy
    // from. If staging was cleared (rollback / wipe) there's nothing to source.
    if (staging?.status === 'live') {
      return { to: 'production', label: 'Re-promote to production', confirm: true };
    }
    return null;
  }
  if (staging?.status === 'live') {
    return { to: 'production', label: 'Promote to production', confirm: true };
  }
  if (dev?.status === 'live') {
    return { to: 'staging', label: 'Promote to staging', confirm: false };
  }
  return null;
}

export function ReleaseStrip({ report, epicId, canDeploy, blockedReason, planId }: Props) {
  const promote = usePromoteApp(planId);
  const forceRebuild = useDeployApp();

  const pill = useMemo(() => deriveVerdictPill(report), [report]);
  const action = useMemo(() => nextLadderAction(report), [report]);

  const deploying =
    report.verdict === 'deploying' ||
    (report.environments ?? []).some((e) => e.status === 'deploying');

  const busy = deploying || promote.isPending || forceRebuild.isPending;
  // Primary CTA needs a ladder action available + not blocked + not busy.
  const canAct = canDeploy && !!action && !busy;

  const current = report.current;
  const lastDeploy = useMemo(() => {
    if (!current) return null;
    return { ago: relTime(current.finishedAtIso ?? current.startedAtIso), jobId: current.jobId };
  }, [current]);

  // --- Production typed-confirm (mirrors the ladder's PROMOTE gate) ---
  const [confirming, setConfirming] = useState(false);
  const [typed, setTyped] = useState('');

  // --- Force-rebuild escape hatch (secondary, bypass) ---
  const [showForce, setShowForce] = useState(false);
  const [forceTyped, setForceTyped] = useState('');

  function runPromote(to: 'staging' | 'production') {
    promote.mutate(to);
  }

  function onPrimary() {
    if (!canAct || !action) return;
    if (action.confirm) {
      setConfirming(true);
      return;
    }
    runPromote(action.to);
  }

  const primaryLabel = promote.isPending
    ? 'Promoting…'
    : deploying
      ? 'Deploying…'
      : (action?.label ?? 'No promotion available');

  const errorMsg =
    promote.error instanceof Error
      ? promote.error.message
      : forceRebuild.error instanceof Error
        ? forceRebuild.error.message
        : null;

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
      {/* Verdict pill — furthest live rung (B4) */}
      <div
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: 10,
          padding: '8px 16px',
          border: `1px solid ${pill.color}`,
          background: `color-mix(in srgb, ${pill.color} 8%, transparent)`,
          borderRadius: 2,
        }}
      >
        <span
          className={pill.pulse ? 'animate-pulse-soft' : ''}
          style={{
            background: pill.color,
            width: 8,
            height: 8,
            borderRadius: '50%',
            display: 'inline-block',
            boxShadow: pill.pulse ? `0 0 10px ${pill.color}` : 'none',
          }}
        />
        <span
          style={{
            fontFamily: 'var(--font-mono)',
            fontSize: 11,
            color: pill.color,
            textTransform: 'uppercase',
            letterSpacing: '0.18em',
            fontWeight: 500,
          }}
        >
          {pill.label}
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

      {/* Mutation error surface */}
      {errorMsg && (
        <span
          role="alert"
          style={{
            fontFamily: 'var(--font-mono)',
            fontSize: 10,
            color: 'var(--destructive)',
            letterSpacing: '0.04em',
            maxWidth: 320,
          }}
        >
          {errorMsg}
        </span>
      )}

      {/* CTAs */}
      <div
        style={{
          marginLeft: 'auto',
          display: 'flex',
          alignItems: 'center',
          gap: 10,
          flexWrap: 'wrap',
          justifyContent: 'flex-end',
        }}
      >
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

        {/* Force-rebuild escape hatch (B1) — secondary, ghost, bypass-warned. */}
        {epicId &&
          (showForce ? (
            <ForceRebuildConfirm
              typed={forceTyped}
              setTyped={setForceTyped}
              busy={busy}
              onConfirm={() => {
                if (forceTyped.trim().toUpperCase() === 'REBUILD') {
                  forceRebuild.mutate({ epicId, environment: 'production' });
                  setShowForce(false);
                  setForceTyped('');
                }
              }}
              onCancel={() => {
                setShowForce(false);
                setForceTyped('');
              }}
            />
          ) : (
            <button
              type="button"
              onClick={() => setShowForce(true)}
              disabled={busy}
              title="Bypasses staging + the build-once artifact. Use only to recover a broken ladder."
              style={ghostCta(busy)}
            >
              <AlertTriangle size={11} />
              Force rebuild to prod
            </button>
          ))}

        {/* Primary CTA — ladder advance (B1) */}
        {confirming ? (
          <ProdPromoteConfirm
            typed={typed}
            setTyped={setTyped}
            busy={busy}
            isRePromote={(report.environments ?? []).some(
              (e) => e.environment === 'production' && e.status === 'live',
            )}
            onConfirm={() => {
              if (typed.trim().toUpperCase() === 'PROMOTE') {
                runPromote('production');
                setConfirming(false);
                setTyped('');
              }
            }}
            onCancel={() => {
              setConfirming(false);
              setTyped('');
            }}
          />
        ) : (
          <button
            type="button"
            onClick={onPrimary}
            disabled={!canAct}
            title={
              !canAct
                ? action
                  ? blockedReason || 'Promotion not available'
                  : 'No further rung to promote — deploy dev first'
                : undefined
            }
            style={primaryCta(!canAct)}
          >
            {promote.isPending || deploying ? (
              <Loader2 size={11} className="animate-spin" />
            ) : (
              <Rocket size={11} />
            )}
            {primaryLabel}
          </button>
        )}
      </div>
    </div>
  );
}

/** Production promote typed-confirm — mirrors the ladder's PROMOTE gate. */
function ProdPromoteConfirm({
  typed,
  setTyped,
  busy,
  isRePromote = false,
  onConfirm,
  onCancel,
}: {
  typed: string;
  setTyped: (v: string) => void;
  busy: boolean;
  isRePromote?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const armed = typed.trim().toUpperCase() === 'PROMOTE';
  return (
    <div style={{ display: 'inline-flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
      <span style={{ fontSize: 10, color: 'var(--warning)', maxWidth: 220, lineHeight: 1.4 }}>
        {isRePromote
          ? 'Re-publishes the same artifact to production. '
          : 'Promotes staging → production (advances main). '}
        Type <strong>PROMOTE</strong>.
      </span>
      <input
        value={typed}
        onChange={(e) => setTyped(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && armed && !busy) onConfirm();
        }}
        autoFocus
        placeholder="PROMOTE"
        aria-label="Type PROMOTE to confirm production promotion"
        style={{
          fontSize: 11,
          fontFamily: 'var(--font-mono)',
          padding: '6px 8px',
          border: '1px solid var(--border-2)',
          borderRadius: 2,
          background: 'var(--background)',
          color: 'var(--foreground)',
          width: 110,
        }}
      />
      <button
        type="button"
        onClick={onConfirm}
        disabled={busy || !armed}
        style={{
          ...primaryCta(busy || !armed),
        }}
      >
        {busy ? <Loader2 size={11} className="animate-spin" /> : <Rocket size={11} />}
        {busy ? 'Promoting…' : 'Ship it'}
      </button>
      <button type="button" onClick={onCancel} style={ghostCta(false)}>
        Cancel
      </button>
    </div>
  );
}

/** Force-rebuild typed-confirm — the bypass escape hatch (B1). */
function ForceRebuildConfirm({
  typed,
  setTyped,
  busy,
  onConfirm,
  onCancel,
}: {
  typed: string;
  setTyped: (v: string) => void;
  busy: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const armed = typed.trim().toUpperCase() === 'REBUILD';
  return (
    <div
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 8,
        flexWrap: 'wrap',
        padding: '6px 10px',
        border: '1px solid var(--destructive)',
        borderRadius: 2,
        background: 'color-mix(in srgb, var(--destructive) 8%, transparent)',
      }}
    >
      <AlertTriangle
        size={12}
        style={{ color: 'var(--destructive)', flexShrink: 0 }}
        aria-hidden="true"
      />
      <span
        id="force-rebuild-warning"
        style={{ fontSize: 10, color: 'var(--destructive)', maxWidth: 240, lineHeight: 1.4 }}
      >
        Bypasses staging + the build-once artifact — a fresh prod build. Type{' '}
        <strong>REBUILD</strong> to confirm.
      </span>
      <input
        value={typed}
        onChange={(e) => setTyped(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && armed && !busy) onConfirm();
        }}
        autoFocus
        placeholder="REBUILD"
        aria-label="Type REBUILD to confirm a staging-bypassing fresh production build"
        aria-describedby="force-rebuild-warning"
        style={{
          fontSize: 11,
          fontFamily: 'var(--font-mono)',
          padding: '6px 8px',
          border: '1px solid var(--border-2)',
          borderRadius: 2,
          background: 'var(--background)',
          color: 'var(--foreground)',
          width: 110,
        }}
      />
      <button
        type="button"
        onClick={onConfirm}
        disabled={busy || !armed}
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: 6,
          fontSize: 10,
          letterSpacing: '0.14em',
          textTransform: 'uppercase',
          padding: '7px 14px',
          border: '1px solid var(--destructive)',
          borderRadius: 2,
          color: busy || !armed ? 'var(--text-faint)' : 'var(--destructive)',
          background: 'transparent',
          fontWeight: 500,
          cursor: busy || !armed ? 'not-allowed' : 'pointer',
          opacity: busy || !armed ? 0.5 : 1,
        }}
      >
        {busy ? <Loader2 size={11} className="animate-spin" /> : <RefreshCw size={11} />}
        Force rebuild
      </button>
      <button type="button" onClick={onCancel} style={ghostCta(false)}>
        Cancel
      </button>
    </div>
  );
}

function primaryCta(disabled: boolean): React.CSSProperties {
  return {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 6,
    fontSize: 10,
    letterSpacing: '0.14em',
    textTransform: 'uppercase',
    padding: '7px 14px',
    border: disabled ? '1px solid var(--border-2)' : '1px solid var(--success)',
    borderRadius: 2,
    color: disabled ? 'var(--text-faint)' : 'var(--background)',
    background: disabled ? 'transparent' : 'var(--success)',
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
