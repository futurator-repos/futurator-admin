'use client';

/**
 * Environment ladder — the dev → staging → production promotion strip.
 *
 * Deployment v2.5 §5. Each rung shows its live URL + status and (for staging
 * and production) a promote button that's enabled only when the rung below is
 * live. Production promotion is a delivery event (advances main), so it's
 * gated behind a typed confirmation.
 */

import { useState } from 'react';
import { Loader2, ArrowRight, ExternalLink, Rocket } from 'lucide-react';
import type { DeployEnvironmentStatus } from '@/types/deploy-report';
import { usePromoteApp } from '@/hooks/use-deploy-report';

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

export function EnvironmentLadder({
  environments,
  planId,
}: {
  environments: DeployEnvironmentStatus[];
  planId: string;
}) {
  const promote = usePromoteApp(planId);

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
            <Rung env={env} promote={promote} />
            {i < environments.length - 1 && (
              <ArrowRight
                size={16}
                style={{ color: 'var(--text-faint)', margin: '0 14px', flexShrink: 0 }}
              />
            )}
          </div>
        ))}
      </div>

      {promote.isError && (
        <p style={{ marginTop: 12, fontSize: 11, color: 'var(--warning)' }}>
          {promote.error instanceof Error ? promote.error.message : 'Promotion failed.'}
        </p>
      )}
    </section>
  );
}

function Rung({
  env,
  promote,
}: {
  env: DeployEnvironmentStatus;
  promote: ReturnType<typeof usePromoteApp>;
}) {
  const [confirming, setConfirming] = useState(false);
  const [typed, setTyped] = useState('');
  const meta = ENV_META[env.environment];
  const color = STATUS_COLOR[env.status];
  const deploying = env.status === 'deploying' || promote.isPending;

  function onPromote() {
    if (env.environment === 'staging') {
      promote.mutate('staging');
    } else if (env.environment === 'production') {
      setConfirming(true);
    }
  }

  return (
    <div
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
          <ExternalLink size={9} style={{ flexShrink: 0 }} />
        </a>
      ) : (
        <span style={{ fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--text-faint)' }}>
          —
        </span>
      )}

      {env.environment !== 'dev' &&
        (confirming ? (
          <ProdConfirm
            typed={typed}
            setTyped={setTyped}
            busy={deploying}
            onConfirm={() => {
              if (typed.trim().toUpperCase() === 'PROMOTE') {
                promote.mutate('production');
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
            onClick={onPromote}
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
            {deploying ? <Loader2 size={10} className="animate-spin" /> : <Rocket size={10} />}
            {deploying ? 'Promoting…' : `Promote to ${meta.label}`}
          </button>
        ))}
    </div>
  );
}

function ProdConfirm({
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
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: 2 }}>
      <span style={{ fontSize: 10, color: 'var(--warning)', lineHeight: 1.4 }}>
        Goes live + advances main. Type <strong>PROMOTE</strong> to confirm.
      </span>
      <input
        value={typed}
        onChange={(e) => setTyped(e.target.value)}
        autoFocus
        placeholder="PROMOTE"
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
          disabled={busy || typed.trim().toUpperCase() !== 'PROMOTE'}
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
            cursor: busy || typed.trim().toUpperCase() !== 'PROMOTE' ? 'not-allowed' : 'pointer',
            opacity: busy || typed.trim().toUpperCase() !== 'PROMOTE' ? 0.5 : 1,
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
