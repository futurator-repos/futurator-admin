'use client';

/**
 * Environment ladder — the dev → staging → production promotion strip.
 *
 * Deployment v2.5 §5. Each rung shows its live URL + status and (for staging
 * and production) a promote button that's enabled only when the rung below is
 * live. Production promotion is a delivery event (advances main), so it's
 * gated behind a typed confirmation. If staging's smoke test failed, the
 * production confirm shows a soft warning (still allowed — operator decides).
 */

import { useState } from 'react';
import {
  Loader2,
  ArrowRight,
  ExternalLink,
  Rocket,
  CheckCircle,
  AlertTriangle,
  ScrollText,
} from 'lucide-react';
import type { DeployEnvironmentStatus } from '@/types/deploy-report';
import { usePromoteApp } from '@/hooks/use-deploy-report';

type PromoteTarget = 'staging' | 'production';

const ENV_META: Record<DeployEnvironmentStatus['environment'], { label: string; blurb: string }> = {
  dev: { label: 'Dev', blurb: 'What QA tests — click it yourself' },
  staging: { label: 'Staging', blurb: 'Production-shaped pre-prod + smoke test' },
  production: { label: 'Production', blurb: 'Live. Advances main on promote.' },
};

const STATUS_COLOR: Record<DeployEnvironmentStatus['status'], string> = {
  none: 'var(--text-mute)',
  deploying: 'var(--accent-purple)',
  live: 'var(--success)',
  failed: 'var(--destructive)',
};

/**
 * The "actionable" rung the operator should focus on (B3): the rung currently
 * deploying, else the first rung that can be promoted into. Auto-emphasized.
 */
function findActionableEnv(
  environments: DeployEnvironmentStatus[],
): DeployEnvironmentStatus['environment'] | null {
  const deploying = environments.find((e) => e.status === 'deploying');
  if (deploying) return deploying.environment;
  const promotable = environments.find((e) => e.canPromote && e.status !== 'deploying');
  return promotable?.environment ?? null;
}

export function EnvironmentLadder({
  environments,
  planId,
  onViewLogs,
}: {
  environments: DeployEnvironmentStatus[];
  planId: string;
  onViewLogs?: (jobId: string) => void;
}) {
  const promote = usePromoteApp(planId);
  // Which rung the in-flight promote targets — so only THAT rung shows the
  // pending spinner (a single shared mutation would otherwise flip every
  // rung to "Promoting…", misrepresenting the state machine).
  const [pendingTarget, setPendingTarget] = useState<PromoteTarget | null>(null);
  const actionable = findActionableEnv(environments);
  const stagingSmoke = environments.find((e) => e.environment === 'staging')?.smokeStatus;

  function handlePromote(target: PromoteTarget) {
    setPendingTarget(target);
    promote.mutate(target, { onSettled: () => setPendingTarget(null) });
  }

  return (
    <section
      aria-label="Promotion ladder"
      style={{
        border: '1px solid var(--border)',
        borderRadius: 10,
        background: 'var(--bg-elev)',
        padding: '16px 18px',
      }}
    >
      <header
        style={{
          fontFamily: 'var(--font-mono)',
          fontSize: 9,
          letterSpacing: '0.22em',
          textTransform: 'uppercase',
          color: 'var(--text-faint)',
          marginBottom: 14,
        }}
      >
        Promotion ladder · build once, promote the same artifact
      </header>

      <div style={{ display: 'flex', alignItems: 'stretch', gap: 0, flexWrap: 'wrap' }}>
        {environments.map((env, i) => (
          <div key={env.environment} style={{ display: 'flex', alignItems: 'center' }}>
            <Rung
              env={env}
              onPromote={handlePromote}
              promoting={promote.isPending}
              pendingTarget={pendingTarget}
              actionable={env.environment === actionable}
              onViewLogs={onViewLogs}
              stagingSmokeWarn={env.environment === 'production' ? stagingSmoke : undefined}
            />
            {i < environments.length - 1 && (
              <ArrowRight
                size={16}
                aria-hidden="true"
                style={{ color: 'var(--text-faint)', margin: '0 14px', flexShrink: 0 }}
              />
            )}
          </div>
        ))}
      </div>

      {promote.isError && (
        <p role="alert" style={{ marginTop: 12, fontSize: 11, color: 'var(--warning)' }}>
          {promote.error instanceof Error ? promote.error.message : 'Promotion failed.'}
        </p>
      )}
    </section>
  );
}

function Rung({
  env,
  onPromote,
  promoting,
  pendingTarget,
  actionable,
  onViewLogs,
  stagingSmokeWarn,
}: {
  env: DeployEnvironmentStatus;
  onPromote: (target: PromoteTarget) => void;
  promoting: boolean;
  pendingTarget: PromoteTarget | null;
  actionable: boolean;
  onViewLogs?: (jobId: string) => void;
  /** Staging's smoke result, threaded to the production rung for the A5 soft gate. */
  stagingSmokeWarn?: 'pass' | 'fail';
}) {
  const [confirming, setConfirming] = useState(false);
  const [typed, setTyped] = useState('');
  const meta = ENV_META[env.environment];
  const color = STATUS_COLOR[env.status];
  // Only show pending on the rung whose promotion is actually in flight.
  const isThisPending = promoting && pendingTarget === env.environment;
  const deploying = env.status === 'deploying' || isThisPending;
  // Emphasis ring colour: deploying rungs glow purple, otherwise the
  // actionable rung glows in its promote accent.
  const emphasisColor = env.status === 'deploying' ? STATUS_COLOR.deploying : 'var(--accent-blue)';

  function onPromoteClick() {
    if (env.environment === 'staging') {
      onPromote('staging');
    } else if (env.environment === 'production') {
      setConfirming(true);
    }
  }

  return (
    <div
      aria-current={actionable ? 'step' : undefined}
      style={{
        minWidth: 190,
        border: `1px solid ${env.status === 'live' ? color : 'var(--border)'}`,
        borderTop: `2px solid ${color}`,
        borderRadius: 6,
        padding: '12px 14px',
        display: 'flex',
        flexDirection: 'column',
        gap: 8,
        background: 'var(--background)',
        // B3 — auto-emphasize the in-progress / next-actionable rung. boxShadow
        // never affects layout, so there's no height jump between polls.
        boxShadow: actionable ? `0 0 0 2px ${emphasisColor}` : 'none',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <span
          className={env.status === 'deploying' ? 'animate-pulse-soft' : ''}
          style={{ width: 8, height: 8, borderRadius: '50%', background: color }}
        />
        <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--foreground)' }}>
          {meta.label}
        </span>
        <span
          style={{
            marginLeft: 'auto',
            fontFamily: 'var(--font-mono)',
            fontSize: 9,
            letterSpacing: '0.12em',
            textTransform: 'uppercase',
            color,
          }}
        >
          {env.status}
        </span>
      </div>

      <span style={{ fontSize: 10.5, color: 'var(--text-mute)', lineHeight: 1.4 }}>
        {meta.blurb}
      </span>

      {/* A5 — smoke badge on staging/production. Reserve a fixed-height row so
          the rung never jumps when the badge appears/disappears between polls. */}
      {env.environment !== 'dev' && <SmokeBadge status={env.smokeStatus} />}

      {/* B3 — inline progress on the deploying rung (indeterminate bar +
          "Promoting…" text), in addition to the pulse dot above. */}
      {deploying && <PromotingProgress />}

      {env.url && env.status === 'live' ? (
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
            wordBreak: 'break-all',
          }}
        >
          {env.url.replace('https://', '')}
          <ExternalLink size={9} aria-hidden="true" style={{ flexShrink: 0 }} />
        </a>
      ) : (
        <span style={{ fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--text-faint)' }}>
          —
        </span>
      )}

      {/* B3 — per-rung "View logs": surfaces this env's deploy stream in the
          shared DeployLogs panel below the ladder. */}
      {env.activeJobId && onViewLogs && (
        <button
          type="button"
          onClick={() => onViewLogs(env.activeJobId as string)}
          aria-label={`View ${meta.label} deploy logs`}
          title={`View ${meta.label} deploy logs`}
          style={{
            alignSelf: 'flex-start',
            display: 'inline-flex',
            alignItems: 'center',
            gap: 5,
            fontFamily: 'var(--font-mono)',
            fontSize: 9,
            letterSpacing: '0.12em',
            textTransform: 'uppercase',
            padding: '3px 7px',
            border: '1px solid var(--border-2)',
            borderRadius: 2,
            color: 'var(--text-dim)',
            background: 'transparent',
            cursor: 'pointer',
          }}
        >
          <ScrollText size={10} aria-hidden="true" />
          View logs
        </button>
      )}

      {env.environment !== 'dev' &&
        (confirming ? (
          <ProdConfirm
            typed={typed}
            setTyped={setTyped}
            busy={deploying}
            stagingSmokeWarn={stagingSmokeWarn}
            onConfirm={() => {
              if (typed.trim().toUpperCase() === 'PROMOTE') {
                onPromote('production');
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
            onClick={onPromoteClick}
            disabled={!env.canPromote || deploying}
            title={
              !env.canPromote
                ? `Promote the rung below to ${meta.label} once it's live`
                : `Promote into ${meta.label}`
            }
            style={{
              marginTop: 2,
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
              gap: 6,
              fontSize: 10,
              letterSpacing: '0.12em',
              textTransform: 'uppercase',
              padding: '6px 12px',
              border: `1px solid ${env.environment === 'production' ? 'var(--success)' : 'var(--border-2)'}`,
              borderRadius: 2,
              color:
                !env.canPromote || deploying
                  ? 'var(--text-faint)'
                  : env.environment === 'production'
                    ? 'var(--success)'
                    : 'var(--text-dim)',
              background:
                env.environment === 'production' && env.canPromote
                  ? 'color-mix(in srgb, var(--success) 10%, transparent)'
                  : 'transparent',
              cursor: !env.canPromote || deploying ? 'not-allowed' : 'pointer',
              opacity: !env.canPromote || deploying ? 0.5 : 1,
            }}
          >
            {deploying ? (
              <Loader2 size={10} className="animate-spin" aria-hidden="true" />
            ) : (
              <Rocket size={10} aria-hidden="true" />
            )}
            {deploying ? 'Promoting…' : `Promote to ${meta.label}`}
          </button>
        ))}
    </div>
  );
}

/**
 * A5 — smoke-test outcome badge for staging/production rungs. Color is paired
 * with an icon + text + aria-label so it's not the only signal (colorblind
 * safety). Always renders a fixed-height row (even when undefined) to prevent
 * layout shift between polls.
 */
function SmokeBadge({ status }: { status?: 'pass' | 'fail' }) {
  const passed = status === 'pass';
  const failed = status === 'fail';
  const label = passed ? 'Smoke test passed' : failed ? 'Smoke test failed' : undefined;
  return (
    <span
      {...(label ? { 'aria-label': label } : {})}
      style={{
        minHeight: 14,
        display: 'inline-flex',
        alignItems: 'center',
        gap: 5,
        fontFamily: 'var(--font-mono)',
        fontSize: 9,
        letterSpacing: '0.1em',
        textTransform: 'uppercase',
        color: passed ? 'var(--success)' : failed ? 'var(--warning)' : 'transparent',
      }}
    >
      {passed && <CheckCircle size={10} aria-hidden="true" />}
      {failed && <AlertTriangle size={10} aria-hidden="true" />}
      {passed ? 'smoke' : failed ? 'smoke failed' : ''}
    </span>
  );
}

/** B3 — indeterminate progress affordance shown while a rung is deploying. */
function PromotingProgress() {
  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 5,
      }}
    >
      <span
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: 6,
          fontFamily: 'var(--font-mono)',
          fontSize: 9,
          letterSpacing: '0.12em',
          textTransform: 'uppercase',
          color: 'var(--accent-purple)',
        }}
      >
        <Loader2 size={10} className="animate-spin" aria-hidden="true" />
        Promoting…
      </span>
      <span
        aria-hidden="true"
        className="animate-pulse-soft"
        style={{
          height: 3,
          borderRadius: 2,
          background: 'color-mix(in srgb, var(--accent-purple) 45%, transparent)',
        }}
      />
    </div>
  );
}

function ProdConfirm({
  typed,
  setTyped,
  busy,
  stagingSmokeWarn,
  onConfirm,
  onCancel,
}: {
  typed: string;
  setTyped: (v: string) => void;
  busy: boolean;
  stagingSmokeWarn?: 'pass' | 'fail';
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const armed = typed.trim().toUpperCase() === 'PROMOTE';
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: 2 }}>
      {/* A5 soft gate — warn (do not block) when staging smoke failed. */}
      {stagingSmokeWarn === 'fail' && (
        <span
          role="alert"
          style={{
            display: 'inline-flex',
            alignItems: 'flex-start',
            gap: 5,
            fontSize: 10,
            color: 'var(--destructive)',
            lineHeight: 1.4,
          }}
        >
          <AlertTriangle size={11} aria-hidden="true" style={{ flexShrink: 0, marginTop: 1 }} />
          Staging smoke test FAILED — you are promoting a build with known issues.
        </span>
      )}
      <span style={{ fontSize: 10, color: 'var(--warning)', lineHeight: 1.4 }}>
        Goes live + advances main. Type <strong>PROMOTE</strong> to confirm.
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
          padding: '5px 8px',
          border: '1px solid var(--border-2)',
          borderRadius: 2,
          background: 'var(--background)',
          color: 'var(--foreground)',
        }}
      />
      <div style={{ display: 'flex', gap: 6 }}>
        <button
          type="button"
          onClick={onConfirm}
          disabled={busy || !armed}
          style={{
            flex: 1,
            fontSize: 10,
            letterSpacing: '0.1em',
            textTransform: 'uppercase',
            padding: '6px 10px',
            border: '1px solid var(--success)',
            borderRadius: 2,
            color: 'var(--background)',
            background: 'var(--success)',
            cursor: busy || !armed ? 'not-allowed' : 'pointer',
            opacity: busy || !armed ? 0.5 : 1,
          }}
        >
          {busy ? 'Promoting…' : 'Ship it'}
        </button>
        <button
          type="button"
          onClick={onCancel}
          style={{
            fontSize: 10,
            letterSpacing: '0.1em',
            textTransform: 'uppercase',
            padding: '6px 10px',
            border: '1px solid var(--border-2)',
            borderRadius: 2,
            color: 'var(--text-dim)',
            background: 'transparent',
            cursor: 'pointer',
          }}
        >
          Cancel
        </button>
      </div>
    </div>
  );
}
